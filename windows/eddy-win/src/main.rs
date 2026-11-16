#![cfg(windows)]
//! eddy-win: runs the engine on real Windows devices.
//!
//!   eddy-win list [--json]
//!   eddy-win run [--mic NAME] [--out NAME] [--virtual-mic NAME] [--system NAME]
//!
//! Wiring (the "Streaming" profile): microphone -> engine source 0, Headphones destination
//! -> the output device (clock master), Eddy Mic destination -> the virtual cable render
//! device (`--virtual-mic`, the thing voice apps pick as their microphone).
//!
//! `--system NAME` is a *virtual* output device that Windows is set to play to. Eddy captures
//! it (loopback) as "System sound" and plays the mix to your real `--out`. It must never be the
//! same device as `--out`: capturing the device we play to would feed Eddy back into itself.

use eddy_engine::engine::{Engine, EngineConfig};
use eddy_engine::drift::DriftReader;
use eddy_engine::ipc::Server;
use eddy_engine::profile::Profile;
use eddy_engine::store::Store;
use eddy_json::Json;
use eddy_win::{capture, devices, render};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    devices::com_init().expect("COM init failed");
    match args.get(1).map(String::as_str) {
        Some("list") if args.iter().any(|a| a == "--json") => {
            // One JSON array on stdout, read by the desktop app: [{"id","name","render","default"}]
            let items = devices::list().expect("could not list devices").into_iter().map(|d| Json::obj()
                .with("id", d.id).with("name", d.name).with("render", d.is_render).with("default", d.is_default)).collect::<Vec<_>>();
            println!("{}", Json::Arr(items).to_string());
        }
        Some("list") => {
            for d in devices::list().expect("could not list devices") {
                println!("{} {:7} {}{}", if d.is_default { "*" } else { " " }, if d.is_render { "output" } else { "input" }, d.name, "");
                println!("    id: {}", d.id);
            }
        }
        Some("run") => run(&args),
        _ => eprintln!("usage: eddy-win list | eddy-win run [--mic NAME] [--out NAME] [--virtual-mic NAME] [--system NAME]"),
    }
}

fn run(args: &[String]) {
    let all = devices::list().expect("could not list devices");
    let pick = |flag: &str, render: bool| arg(args, flag).map(|q| devices::find(&all, render, &q).unwrap_or_else(|| panic!("no device matching {q:?}, try `eddy-win list`")).id);
    let (mic, out, vmic, system) = (pick("--mic", false), pick("--out", true), pick("--virtual-mic", true), pick("--system", true));
    if system.is_some() && system == out { panic!("--system and --out are the same device, that would feed Eddy back into itself"); }
    if system.is_some() && system == vmic { panic!("--system and --virtual-mic are the same device: Eddy would capture the cable it is writing into"); }
    if vmic.is_some() && vmic == out { panic!("--virtual-mic and --out are the same device, pick your real headphones for --out"); }

    let profile = Profile::streaming();
    let sources: Vec<(&str, bool)> = profile.sources.iter().map(|s| (s.name.as_str(), s.voice.is_some())).collect();
    let dests: Vec<&str> = profile.destinations.iter().map(|d| d.name.as_str()).collect();
    let cfg = EngineConfig::new(48_000, &sources, &dests);
    let target_fill = cfg.target_fill_frames;
    let parts = Engine::build(cfg);

    let stop = Arc::new(AtomicBool::new(false));
    let mut threads = Vec::new();
    let mut inputs = parts.source_inputs;
    let mut outputs = parts.dest_outputs;

    // capture: source 0 = mic, source 4 = system sound (loopback of the output device)
    let sys_in = inputs.pop().unwrap();
    let _unused_middle: Vec<_> = inputs.drain(1..).collect(); // app sources need process loopback (not built yet)
    let mic_in = inputs.pop().unwrap();
    threads.push(capture::spawn(mic, false, mic_in, stop.clone()));
    if system.is_some() {
        threads.push(capture::spawn(system, true, sys_in, stop.clone()));
    }

    // render: destination 2 (stream) is unused for now, destination 1 goes to the virtual cable
    let _stream = outputs.pop().unwrap();
    let vmic_out = outputs.pop().unwrap();
    let headphones = outputs.pop().unwrap();
    if vmic.is_some() {
        threads.push(render::spawn(vmic, render::Role::Follower { reader: DriftReader::new(vmic_out, target_fill) }, stop.clone()));
    }
    threads.push(render::spawn(out, render::Role::Master { engine: Box::new(parts.engine), dest: headphones }, stop.clone()));

    // control: JSON lines on stdin, so the UI (or you) can drive it while it runs
    let mut server = Server::new(parts.handle, profile.clone(), Store::new("profiles"));
    server.apply_profile(profile).ok();
    eprintln!("running, type JSON commands (for example {{\"cmd\":\"get_state\"}}), Ctrl+Z then Enter to quit");
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        let mut o = stdout.lock();
        let _ = writeln!(o, "{}", server.handle_line(&line));
    }
    stop.store(true, Ordering::Relaxed);
    for t in threads {
        if let Ok(Err(e)) = t.join() { eprintln!("audio thread stopped: {e}"); }
    }
}
