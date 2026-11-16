use crate::profile::Profile;
use eddy_json::Json;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq)]
pub struct BackupInfo { pub timestamp_ms: u64, pub path: PathBuf }

/// Versioned profile storage: every save writes a new timestamped file and keeps the last N.
/// A corrupt or half-written newest file never loses your setup, loading falls back to the
/// previous good one. This is what the Health screen's backups list and Repair button use.
pub struct Store { dir: PathBuf, keep: usize }

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self { Self { dir: dir.into(), keep: 20 } }
    pub fn with_keep(mut self, keep: usize) -> Self { self.keep = keep.max(1); self }

    fn profile_dir(&self, name: &str) -> PathBuf {
        let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        self.dir.join(safe)
    }

    pub fn list(&self, name: &str) -> io::Result<Vec<BackupInfo>> {
        let dir = self.profile_dir(name);
        if !dir.exists() { return Ok(Vec::new()); }
        let mut v: Vec<BackupInfo> = fs::read_dir(dir)?.filter_map(|e| {
            let p = e.ok()?.path();
            let ts = p.file_stem()?.to_str()?.parse::<u64>().ok()?;
            (p.extension()? == "json").then_some(BackupInfo { timestamp_ms: ts, path: p })
        }).collect();
        v.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
        Ok(v)
    }

    pub fn save(&self, p: &Profile) -> io::Result<BackupInfo> {
        let dir = self.profile_dir(&p.name);
        fs::create_dir_all(&dir)?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let last = self.list(&p.name)?.first().map(|b| b.timestamp_ms).unwrap_or(0);
        let ts = now.max(last + 1);
        let path = dir.join(format!("{ts}.json"));
        let tmp = dir.join(format!("{ts}.tmp"));
        fs::write(&tmp, p.to_json().to_string())?;
        fs::rename(&tmp, &path)?; // atomic on the same volume: readers never see half a file
        for old in self.list(&p.name)?.into_iter().skip(self.keep) { let _ = fs::remove_file(old.path); }
        Ok(BackupInfo { timestamp_ms: ts, path })
    }

    fn read(path: &Path) -> Result<Profile, String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let json = Json::parse(&text).map_err(|e| e.to_string())?;
        Profile::from_json(&json)
    }

    pub fn load(&self, info: &BackupInfo) -> Result<Profile, String> { Self::read(&info.path) }

    /// Newest backup that parses. Returns it with the number of broken files skipped.
    pub fn load_latest_valid(&self, name: &str) -> Result<Option<(Profile, usize)>, String> {
        let mut skipped = 0;
        for b in self.list(name).map_err(|e| e.to_string())? {
            match Self::read(&b.path) {
                Ok(p) => return Ok(Some((p, skipped))),
                Err(_) => skipped += 1,
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("eddy-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn saves_versions_lists_newest_first_and_prunes() {
        let dir = tmpdir("prune");
        let store = Store::new(&dir).with_keep(3);
        let mut p = Profile::streaming();
        for i in 0..5 {
            p.sources[0].gain = i as f32 / 10.0;
            store.save(&p).unwrap();
        }
        let list = store.list("Streaming").unwrap();
        assert_eq!(list.len(), 3);
        assert!(list[0].timestamp_ms > list[1].timestamp_ms);
        let newest = store.load(&list[0]).unwrap();
        assert!((newest.sources[0].gain - 0.4).abs() < 1e-6);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_newest_file_falls_back_to_previous_good_one() {
        let dir = tmpdir("corrupt");
        let store = Store::new(&dir);
        let p = Profile::streaming();
        store.save(&p).unwrap();
        let bad = store.save(&p).unwrap();
        fs::write(&bad.path, "{ this is not json").unwrap();
        let (loaded, skipped) = store.load_latest_valid("Streaming").unwrap().unwrap();
        assert_eq!(loaded, p);
        assert_eq!(skipped, 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unsafe_profile_names_cannot_escape_the_folder() {
        let dir = tmpdir("names");
        let store = Store::new(&dir);
        let mut p = Profile::streaming();
        p.name = "../../evil".into();
        let b = store.save(&p).unwrap();
        assert!(b.path.starts_with(&dir));
        let _ = fs::remove_dir_all(dir);
    }
}
