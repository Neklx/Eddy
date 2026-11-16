use crate::command::{Command, Param, Stage};
use eddy_json::Json;

pub const PROFILE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq)]
pub struct VoiceSettings {
    pub high_pass_hz: f32,
    pub noise_on: bool,
    pub noise_strength: f32,
    pub gate_on: bool,
    pub gate_threshold_db: f32,
    pub gate_release_ms: f32,
    pub eq_on: bool,
    pub comp_on: bool,
    pub comp_threshold_db: f32,
    pub comp_ratio: f32,
    pub comp_makeup_db: f32,
    pub leveler_on: bool,
    pub leveler_target_db: f32,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            high_pass_hz: 80.0, noise_on: true, noise_strength: 0.7, gate_on: true, gate_threshold_db: -50.0,
            gate_release_ms: 120.0, eq_on: true, comp_on: true, comp_threshold_db: -18.0, comp_ratio: 4.0,
            comp_makeup_db: 3.0, leveler_on: true, leveler_target_db: -16.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SourceProfile { pub name: String, pub gain: f32, pub muted: bool, pub voice: Option<VoiceSettings> }

#[derive(Clone, Debug, PartialEq)]
pub struct DestProfile { pub name: String, pub gain: f32 }

#[derive(Clone, Debug, PartialEq)]
pub struct SendProfile { pub src: usize, pub dst: usize, pub gain: f32 }

/// "Always send this app to ..." remembered between sessions.
#[derive(Clone, Debug, PartialEq)]
pub struct AppRule { pub app: String, pub destinations: Vec<String> }

#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub version: u32,
    pub name: String,
    pub sources: Vec<SourceProfile>,
    pub destinations: Vec<DestProfile>,
    pub sends: Vec<SendProfile>,
    pub rules: Vec<AppRule>,
}

impl Profile {
    /// The default "Streaming" profile matching the Mixer screen.
    pub fn streaming() -> Self {
        let src = |n: &str, voice| SourceProfile { name: n.into(), gain: 1.0, muted: false, voice: if voice { Some(VoiceSettings::default()) } else { None } };
        let dst = |n: &str| DestProfile { name: n.into(), gain: 1.0 };
        Self {
            version: PROFILE_VERSION,
            name: "Streaming".into(),
            sources: vec![src("Microphone", true), src("Voice chat app", false), src("Music player", false), src("Game", false), src("System sound", false)],
            destinations: vec![dst("Headphones"), dst("Eddy Mic"), dst("Eddy Stream")],
            sends: vec![
                SendProfile { src: 0, dst: 1, gain: 1.0 }, SendProfile { src: 0, dst: 2, gain: 1.0 },
                SendProfile { src: 1, dst: 0, gain: 1.0 }, SendProfile { src: 2, dst: 0, gain: 1.0 },
                SendProfile { src: 2, dst: 2, gain: 0.5 }, SendProfile { src: 3, dst: 0, gain: 1.0 },
                SendProfile { src: 3, dst: 2, gain: 0.7 }, SendProfile { src: 4, dst: 0, gain: 1.0 },
            ],
            rules: vec![AppRule { app: "Music player".into(), destinations: vec!["Headphones".into(), "Eddy Stream".into()] }],
        }
    }

    pub fn source_index(&self, name: &str) -> Option<usize> { self.sources.iter().position(|s| s.name == name) }

    /// Everything the engine needs to reach this profile's state, as commands.
    pub fn to_commands(&self) -> Vec<Command> {
        let mut out = Vec::new();
        for (s, src) in self.sources.iter().enumerate() {
            let s8 = s as u8;
            out.push(Command::SetSourceGain { src: s8, gain: src.gain });
            out.push(Command::SetSourceMute { src: s8, mute: src.muted });
            if let Some(v) = &src.voice {
                let st = |stage, on| Command::SetStageEnabled { src: s8, stage, on };
                let pr = |param, value| Command::SetParam { src: s8, param, value };
                out.extend([
                    st(Stage::Noise, v.noise_on), st(Stage::Gate, v.gate_on), st(Stage::Eq, v.eq_on),
                    st(Stage::Compressor, v.comp_on), st(Stage::Leveler, v.leveler_on),
                    pr(Param::HighPassHz, v.high_pass_hz), pr(Param::NoiseStrength, v.noise_strength),
                    pr(Param::GateThresholdDb, v.gate_threshold_db), pr(Param::GateReleaseMs, v.gate_release_ms),
                    pr(Param::CompThresholdDb, v.comp_threshold_db), pr(Param::CompRatio, v.comp_ratio),
                    pr(Param::CompMakeupDb, v.comp_makeup_db), pr(Param::LevelerTargetDb, v.leveler_target_db),
                ]);
            }
        }
        for (d, dst) in self.destinations.iter().enumerate() {
            out.push(Command::SetDestGain { dst: d as u8, gain: dst.gain });
        }
        for s in &self.sends {
            out.push(Command::SetSend { src: s.src as u8, dst: s.dst as u8, gain: s.gain });
        }
        out
    }

    pub fn to_json(&self) -> Json {
        let voice = |v: &VoiceSettings| Json::obj()
            .with("high_pass_hz", v.high_pass_hz).with("noise_on", v.noise_on).with("noise_strength", v.noise_strength)
            .with("gate_on", v.gate_on).with("gate_threshold_db", v.gate_threshold_db).with("gate_release_ms", v.gate_release_ms)
            .with("eq_on", v.eq_on).with("comp_on", v.comp_on).with("comp_threshold_db", v.comp_threshold_db)
            .with("comp_ratio", v.comp_ratio).with("comp_makeup_db", v.comp_makeup_db)
            .with("leveler_on", v.leveler_on).with("leveler_target_db", v.leveler_target_db);
        Json::obj()
            .with("version", self.version).with("name", self.name.as_str())
            .with("sources", Json::Arr(self.sources.iter().map(|s| {
                let mut o = Json::obj().with("name", s.name.as_str()).with("gain", s.gain).with("muted", s.muted);
                if let Some(v) = &s.voice { o = o.with("voice", voice(v)); }
                o
            }).collect()))
            .with("destinations", Json::Arr(self.destinations.iter().map(|d| Json::obj().with("name", d.name.as_str()).with("gain", d.gain)).collect()))
            .with("sends", Json::Arr(self.sends.iter().map(|s| Json::obj().with("src", s.src).with("dst", s.dst).with("gain", s.gain)).collect()))
            .with("rules", Json::Arr(self.rules.iter().map(|r| Json::obj().with("app", r.app.as_str()).with("destinations", r.destinations.clone())).collect()))
    }

    /// Missing optional fields fall back to defaults so older files keep loading.
    pub fn from_json(j: &Json) -> Result<Profile, String> {
        let name = j.get("name").and_then(Json::as_str).ok_or("profile has no name")?.to_string();
        let version = j.get("version").and_then(Json::as_i64).unwrap_or(1) as u32;
        if version > PROFILE_VERSION { return Err(format!("profile version {version} is newer than this app understands")); }
        let d = VoiceSettings::default();
        let voice = |v: &Json| VoiceSettings {
            high_pass_hz: v.get("high_pass_hz").and_then(Json::as_f32).unwrap_or(d.high_pass_hz),
            noise_on: v.get("noise_on").and_then(Json::as_bool).unwrap_or(d.noise_on),
            noise_strength: v.get("noise_strength").and_then(Json::as_f32).unwrap_or(d.noise_strength),
            gate_on: v.get("gate_on").and_then(Json::as_bool).unwrap_or(d.gate_on),
            gate_threshold_db: v.get("gate_threshold_db").and_then(Json::as_f32).unwrap_or(d.gate_threshold_db),
            gate_release_ms: v.get("gate_release_ms").and_then(Json::as_f32).unwrap_or(d.gate_release_ms),
            eq_on: v.get("eq_on").and_then(Json::as_bool).unwrap_or(d.eq_on),
            comp_on: v.get("comp_on").and_then(Json::as_bool).unwrap_or(d.comp_on),
            comp_threshold_db: v.get("comp_threshold_db").and_then(Json::as_f32).unwrap_or(d.comp_threshold_db),
            comp_ratio: v.get("comp_ratio").and_then(Json::as_f32).unwrap_or(d.comp_ratio),
            comp_makeup_db: v.get("comp_makeup_db").and_then(Json::as_f32).unwrap_or(d.comp_makeup_db),
            leveler_on: v.get("leveler_on").and_then(Json::as_bool).unwrap_or(d.leveler_on),
            leveler_target_db: v.get("leveler_target_db").and_then(Json::as_f32).unwrap_or(d.leveler_target_db),
        };
        let arr = |k: &str| j.get(k).and_then(Json::as_arr).unwrap_or(&[]);
        let sources = arr("sources").iter().map(|s| Ok(SourceProfile {
            name: s.get("name").and_then(Json::as_str).ok_or("source without name")?.to_string(),
            gain: s.get("gain").and_then(Json::as_f32).unwrap_or(1.0),
            muted: s.get("muted").and_then(Json::as_bool).unwrap_or(false),
            voice: s.get("voice").map(voice),
        })).collect::<Result<Vec<_>, &str>>()?;
        let destinations = arr("destinations").iter().map(|x| Ok(DestProfile {
            name: x.get("name").and_then(Json::as_str).ok_or("destination without name")?.to_string(),
            gain: x.get("gain").and_then(Json::as_f32).unwrap_or(1.0),
        })).collect::<Result<Vec<_>, &str>>()?;
        let sends = arr("sends").iter().map(|x| {
            let (s, d) = (x.get("src").and_then(Json::as_i64).ok_or("send without src")? as usize, x.get("dst").and_then(Json::as_i64).ok_or("send without dst")? as usize);
            if s >= sources.len() || d >= destinations.len() { return Err("send points outside the profile"); }
            Ok(SendProfile { src: s, dst: d, gain: x.get("gain").and_then(Json::as_f32).unwrap_or(1.0) })
        }).collect::<Result<Vec<_>, &str>>()?;
        let rules = arr("rules").iter().filter_map(|r| Some(AppRule {
            app: r.get("app")?.as_str()?.to_string(),
            destinations: r.get("destinations")?.as_arr()?.iter().filter_map(|d| d.as_str().map(String::from)).collect(),
        })).collect();
        Ok(Profile { version, name, sources, destinations, sends, rules })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_through_json_text() {
        let p = Profile::streaming();
        let text = p.to_json().to_string();
        let back = Profile::from_json(&Json::parse(&text).unwrap()).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn old_files_missing_fields_still_load_and_bad_ones_are_rejected() {
        let j = Json::parse(r#"{"name":"Old","sources":[{"name":"Microphone","voice":{"noise_strength":0.3}}],"destinations":[{"name":"Headphones"}],"sends":[]}"#).unwrap();
        let p = Profile::from_json(&j).unwrap();
        let v = p.sources[0].voice.as_ref().unwrap();
        assert_eq!(v.noise_strength, 0.3);
        assert_eq!(v.comp_ratio, 4.0);

        let bad = Json::parse(r#"{"name":"X","sources":[],"destinations":[],"sends":[{"src":3,"dst":0}]}"#).unwrap();
        assert!(Profile::from_json(&bad).is_err());
        let future = Json::parse(r#"{"name":"X","version":99}"#).unwrap();
        assert!(Profile::from_json(&future).unwrap_err().contains("newer"));
    }

    #[test]
    fn produces_commands_for_every_send() {
        let p = Profile::streaming();
        let sends = p.to_commands().iter().filter(|c| matches!(c, Command::SetSend { .. })).count();
        assert_eq!(sends, p.sends.len());
    }
}
