//! Control protocol between the UI and the engine process: one JSON object per line.
//! Request:  {"id":1,"cmd":"set_send","src":0,"dst":1,"gain":1.0}
//! Response: {"id":1,"ok":true,"data":{...}}  or  {"id":1,"ok":false,"error":"..."}

use crate::command::{Command, Param, Stage};
use crate::engine::EngineHandle;
use crate::profile::Profile;
use crate::store::Store;
use crate::telemetry::Telemetry;
use eddy_json::Json;

pub struct Server {
    pub handle: EngineHandle,
    pub profile: Profile,
    pub store: Store,
}

impl Server {
    pub fn new(handle: EngineHandle, profile: Profile, store: Store) -> Self { Self { handle, profile, store } }

    /// Applies a whole profile to the running engine.
    pub fn apply_profile(&mut self, p: Profile) -> Result<(), String> {
        for c in p.to_commands() {
            if !self.handle.send(c) { return Err("engine is not accepting commands".into()); }
        }
        self.profile = p;
        Ok(())
    }

    pub fn handle_line(&mut self, line: &str) -> String {
        let req = match Json::parse(line) {
            Ok(j) => j,
            Err(e) => return reply(None, Err(e.to_string())),
        };
        let id = req.get("id").cloned();
        reply(id, self.dispatch(&req))
    }

    fn dispatch(&mut self, req: &Json) -> Result<Json, String> {
        let cmd = req.get("cmd").and_then(Json::as_str).ok_or("missing cmd")?;
        let idx = |k: &str| req.get(k).and_then(Json::as_i64).filter(|v| (0..=255).contains(v)).map(|v| v as u8).ok_or(format!("missing or bad {k}"));
        let num = |k: &str| req.get(k).and_then(Json::as_f32).ok_or(format!("missing or bad {k}"));
        let flag = |k: &str| req.get(k).and_then(Json::as_bool).ok_or(format!("missing or bad {k}"));
        let (ns, nd) = (self.profile.sources.len(), self.profile.destinations.len());
        let check_src = |s: u8| if (s as usize) < ns { Ok(s) } else { Err("source out of range".to_string()) };
        let check_dst = |d: u8| if (d as usize) < nd { Ok(d) } else { Err("destination out of range".to_string()) };

        let send = |h: &mut EngineHandle, c: Command| if h.send(c) { Ok(Json::Null) } else { Err("engine is busy, try again".to_string()) };

        match cmd {
            "ping" => Ok(Json::obj().with("pong", true)),
            "get_state" => {
                let t = &self.handle.telemetry;
                Ok(Json::obj()
                    .with("cpu_percent", t.cpu_percent())
                    .with("sources", Json::Arr(self.profile.sources.iter().enumerate().map(|(i, s)| Json::obj()
                        .with("name", s.name.as_str()).with("gain", s.gain).with("muted", s.muted)
                        .with("peak", Telemetry::take_peak(&t.src_peak[i])).with("underruns", t.underruns(i))).collect()))
                    .with("destinations", Json::Arr(self.profile.destinations.iter().enumerate().map(|(i, d)| Json::obj()
                        .with("name", d.name.as_str()).with("gain", d.gain)
                        .with("peak", Telemetry::take_peak(&t.dst_peak[i])).with("overruns", t.overruns(i))).collect())))
            }
            "set_send" => {
                let (s, d, g) = (check_src(idx("src")?)?, check_dst(idx("dst")?)?, num("gain")?.clamp(0.0, 4.0));
                send(&mut self.handle, Command::SetSend { src: s, dst: d, gain: g })?;
                self.profile.sends.retain(|x| !(x.src == s as usize && x.dst == d as usize));
                if g > 0.0 { self.profile.sends.push(crate::profile::SendProfile { src: s as usize, dst: d as usize, gain: g }); }
                Ok(Json::Null)
            }
            "set_source_gain" => {
                let (s, g) = (check_src(idx("src")?)?, num("gain")?.clamp(0.0, 4.0));
                send(&mut self.handle, Command::SetSourceGain { src: s, gain: g })?;
                self.profile.sources[s as usize].gain = g;
                Ok(Json::Null)
            }
            "set_source_mute" => {
                let (s, m) = (check_src(idx("src")?)?, flag("mute")?);
                send(&mut self.handle, Command::SetSourceMute { src: s, mute: m })?;
                self.profile.sources[s as usize].muted = m;
                Ok(Json::Null)
            }
            "set_dest_gain" => {
                let (d, g) = (check_dst(idx("dst")?)?, num("gain")?.clamp(0.0, 4.0));
                send(&mut self.handle, Command::SetDestGain { dst: d, gain: g })?;
                self.profile.destinations[d as usize].gain = g;
                Ok(Json::Null)
            }
            "set_stage" => {
                let s = check_src(idx("src")?)?;
                let stage = Stage::from_name(req.get("stage").and_then(Json::as_str).ok_or("missing stage")?).ok_or("unknown stage")?;
                let on = flag("on")?;
                if self.profile.sources[s as usize].voice.is_none() { return Err("that source has no voice chain".into()); }
                send(&mut self.handle, Command::SetStageEnabled { src: s, stage, on })?;
                let v = self.profile.sources[s as usize].voice.as_mut().unwrap();
                match stage {
                    Stage::Noise => v.noise_on = on, Stage::Gate => v.gate_on = on, Stage::Eq => v.eq_on = on,
                    Stage::Compressor => v.comp_on = on, Stage::Leveler => v.leveler_on = on, Stage::HighPass => {}
                }
                Ok(Json::Null)
            }
            "set_param" => {
                let s = check_src(idx("src")?)?;
                let param = Param::from_name(req.get("param").and_then(Json::as_str).ok_or("missing param")?).ok_or("unknown param")?;
                let value = num("value")?;
                if !value.is_finite() { return Err("value must be a number".into()); }
                if self.profile.sources[s as usize].voice.is_none() { return Err("that source has no voice chain".into()); }
                send(&mut self.handle, Command::SetParam { src: s, param, value })?;
                let v = self.profile.sources[s as usize].voice.as_mut().unwrap();
                match param {
                    Param::HighPassHz => v.high_pass_hz = value, Param::NoiseStrength => v.noise_strength = value,
                    Param::GateThresholdDb => v.gate_threshold_db = value, Param::GateReleaseMs => v.gate_release_ms = value,
                    Param::CompThresholdDb => v.comp_threshold_db = value, Param::CompRatio => v.comp_ratio = value,
                    Param::CompMakeupDb => v.comp_makeup_db = value, Param::LevelerTargetDb => v.leveler_target_db = value,
                }
                Ok(Json::Null)
            }
            "save" => {
                let b = self.store.save(&self.profile).map_err(|e| e.to_string())?;
                Ok(Json::obj().with("timestamp_ms", b.timestamp_ms as f64))
            }
            "list_backups" => {
                let l = self.store.list(&self.profile.name).map_err(|e| e.to_string())?;
                Ok(Json::Arr(l.iter().map(|b| Json::obj().with("timestamp_ms", b.timestamp_ms as f64)).collect()))
            }
            "restore" => {
                let ts = req.get("timestamp_ms").and_then(Json::as_f64).ok_or("missing timestamp_ms")? as u64;
                let info = self.store.list(&self.profile.name).map_err(|e| e.to_string())?.into_iter().find(|b| b.timestamp_ms == ts).ok_or("no such backup")?;
                let p = self.store.load(&info)?;
                self.apply_profile(p)?;
                Ok(Json::Null)
            }
            "repair" => {
                // Reload the newest good saved profile and push it to the engine again.
                match self.store.load_latest_valid(&self.profile.name)? {
                    Some((p, skipped)) => { self.apply_profile(p)?; Ok(Json::obj().with("restored", true).with("broken_files_skipped", skipped)) }
                    None => Ok(Json::obj().with("restored", false).with("broken_files_skipped", 0usize)),
                }
            }
            _ => Err(format!("unknown command {cmd}")),
        }
    }
}

fn reply(id: Option<Json>, r: Result<Json, String>) -> String {
    let mut o = Json::obj();
    if let Some(id) = id { o = o.with("id", id); }
    match r {
        Ok(Json::Null) => o.with("ok", true),
        Ok(data) => o.with("ok", true).with("data", data),
        Err(e) => o.with("ok", false).with("error", e),
    }.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Engine, EngineConfig};

    fn server(tag: &str) -> (Server, crate::engine::EngineParts) {
        let p = Profile::streaming();
        let sources: Vec<(&str, bool)> = p.sources.iter().map(|s| (s.name.as_str(), s.voice.is_some())).collect();
        let dests: Vec<&str> = p.destinations.iter().map(|d| d.name.as_str()).collect();
        let mut parts = Engine::build(EngineConfig::new(48_000, &sources, &dests));
        let dir = std::env::temp_dir().join(format!("eddy-ipc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // the server owns the handle; give the test rig a second handle-less view via the engine
        let handle = std::mem::replace(&mut parts.handle, crate::engine::EngineHandle::dangling(parts.engine.telemetry()));
        (Server::new(handle, p, Store::new(dir)), parts)
    }

    #[test]
    fn commands_reach_the_audio_thread_and_state_reads_back() {
        let (mut s, mut parts) = server("cmds");
        let r = s.handle_line(r#"{"id":7,"cmd":"set_send","src":2,"dst":1,"gain":0.5}"#);
        assert_eq!(Json::parse(&r).unwrap().get("ok").and_then(Json::as_bool), Some(true));
        parts.engine.process_block(64);
        assert!(s.profile.sends.iter().any(|x| x.src == 2 && x.dst == 1 && x.gain == 0.5));
        let st = Json::parse(&s.handle_line(r#"{"id":8,"cmd":"get_state"}"#)).unwrap();
        assert_eq!(st.get("id").and_then(Json::as_i64), Some(8));
        assert_eq!(st.get("data").unwrap().get("sources").unwrap().as_arr().unwrap().len(), 5);
    }

    #[test]
    fn bad_requests_get_errors_not_panics() {
        let (mut s, _p) = server("bad");
        for line in [
            "not json", r#"{"cmd":"set_send","src":99,"dst":0,"gain":1}"#, r#"{"cmd":"set_send","src":0}"#,
            r#"{"cmd":"set_stage","src":1,"stage":"noise","on":true}"#, r#"{"cmd":"set_param","src":0,"param":"nope","value":1}"#,
            r#"{"cmd":"explode"}"#, r#"{"cmd":"set_send","src":-1,"dst":0,"gain":1}"#,
        ] {
            let r = Json::parse(&s.handle_line(line)).unwrap();
            assert_eq!(r.get("ok").and_then(Json::as_bool), Some(false), "{line}");
        }
    }

    #[test]
    fn save_restore_and_repair_flow() {
        let (mut s, _p) = server("flow");
        s.handle_line(r#"{"cmd":"set_source_gain","src":0,"gain":0.8}"#);
        let saved = Json::parse(&s.handle_line(r#"{"cmd":"save"}"#)).unwrap();
        let ts = saved.get("data").unwrap().get("timestamp_ms").unwrap().as_f64().unwrap();
        s.handle_line(r#"{"cmd":"set_source_gain","src":0,"gain":0.2}"#);
        s.handle_line(&format!(r#"{{"cmd":"restore","timestamp_ms":{ts}}}"#));
        assert!((s.profile.sources[0].gain - 0.8).abs() < 1e-6);
        // break the newest file, repair should still bring back a valid profile
        let newest = s.store.list("Streaming").unwrap().remove(0);
        std::fs::write(newest.path, "garbage").unwrap();
        let r = Json::parse(&s.handle_line(r#"{"cmd":"repair"}"#)).unwrap();
        assert_eq!(r.get("ok").and_then(Json::as_bool), Some(true));
        assert_eq!(r.get("data").unwrap().get("restored").and_then(Json::as_bool), Some(false));
    }
}
