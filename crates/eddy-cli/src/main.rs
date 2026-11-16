use eddy_engine::command::Command;
use eddy_engine::engine::{Engine, EngineConfig, EngineParts};
use eddy_engine::ipc::Server;
use eddy_engine::profile::Profile;
use eddy_engine::store::Store;
use std::f32::consts::PI;
use std::io::{BufRead, Write};

const SR: u32 = 48_000;
const BLOCK: usize = 480;

/// A small deterministic noisy "voice": five words with gaps, steady hiss and fan rumble,
/// plus keyboard clicks. Stands in for a real microphone when no audio device is available.
struct FakeMic { t: u64, rng: u32, rumble: f32 }

impl FakeMic {
    fn new() -> Self { Self { t: 0, rng: 12345, rumble: 0.0 } }
    fn noise(&mut self) -> f32 {
        self.rng = self.rng.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.rng >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
    }
    fn sample(&mut self) -> f32 {
        let secs = self.t as f32 / SR as f32;
        self.t += 1;
        let cycle = secs % 6.0;
        let word = [(0.5, 1.1), (1.6, 2.2), (2.7, 3.3), (3.8, 4.4), (4.9, 5.5)].iter().any(|(a, b)| cycle >= *a && cycle < *b);
        let mut v = 0.0;
        if word {
            let f0 = 120.0 + 12.0 * (2.0 * PI * 5.0 * secs).sin();
            let syl = 0.5 + 0.5 * (2.0 * PI * 4.0 * secs).sin().abs();
            for h in 1..=24 {
                let f = f0 * h as f32;
                if f < 7000.0 { v += (2.0 * PI * f * secs).sin() / h as f32; }
            }
            v *= 0.12 * syl;
        }
        let hiss = 0.012 * self.noise();
        self.rumble += 0.01 * (self.noise() - self.rumble);
        let click = if (secs * 1.4).fract() < 0.004 { 0.25 * self.noise() } else { 0.0 };
        v + hiss + 1.5 * self.rumble + click
    }
    fn block(&mut self, frames: usize, out: &mut Vec<f32>) {
        out.clear();
        for _ in 0..frames { let s = self.sample(); out.push(s); out.push(s); }
    }
}

fn rms_db(x: &[f32]) -> f32 { 20.0 * ((x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt().max(1e-6)).log10() }

fn build(profile: &Profile) -> EngineParts {
    let sources: Vec<(&str, bool)> = profile.sources.iter().map(|s| (s.name.as_str(), s.voice.is_some())).collect();
    let dests: Vec<&str> = profile.destinations.iter().map(|d| d.name.as_str()).collect();
    Engine::build(EngineConfig::new(SR, &sources, &dests))
}

fn write_wav(path: &std::path::Path, mono: &[f32]) -> std::io::Result<()> {
    let n = mono.len() as u32;
    let mut b = Vec::with_capacity(44 + n as usize * 4);
    b.extend(b"RIFF"); b.extend((36 + n * 4).to_le_bytes()); b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes()); b.extend(1u16.to_le_bytes()); b.extend(2u16.to_le_bytes());
    b.extend(SR.to_le_bytes()); b.extend((SR * 4).to_le_bytes()); b.extend(4u16.to_le_bytes()); b.extend(16u16.to_le_bytes());
    b.extend(b"data"); b.extend((n * 4).to_le_bytes());
    for s in mono { let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16; b.extend(v.to_le_bytes()); b.extend(v.to_le_bytes()); }
    std::fs::write(path, b)
}

/// Runs the mic through the engine to "Eddy Mic" and returns the mono result.
fn render(profile: &Profile, seconds: usize) -> (Vec<f32>, f32, f32) {
    let mut parts = build(profile);
    for c in profile.to_commands() { parts.handle.send(c); }
    let mic_to_voice_chat = profile.destinations.iter().position(|d| d.name == "Eddy Mic").unwrap() as u8;
    parts.handle.send(Command::SetSend { src: 0, dst: mic_to_voice_chat, gain: 1.0 });
    let mut mic = FakeMic::new();
    let (mut buf, mut out_buf) = (Vec::new(), vec![0.0f32; BLOCK * 2]);
    let mut result = Vec::new();
    let mut worst_cpu = 0.0f32;
    for _ in 0..(seconds * SR as usize / BLOCK) {
        mic.block(BLOCK, &mut buf);
        parts.source_inputs[0].push_slice(&buf);
        parts.engine.process_block(BLOCK);
        worst_cpu = worst_cpu.max(parts.handle.telemetry.cpu_percent());
        let n = parts.dest_outputs[mic_to_voice_chat as usize].pop_slice(&mut out_buf);
        result.extend(out_buf[..n].chunks_exact(2).map(|f| f[0]));
    }
    let latency = parts.engine.voice_latency_ms(0);
    (result, latency, worst_cpu)
}

fn simulate(dir: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let secs = 12;
    let mut raw = Profile::streaming();
    if let Some(v) = raw.sources[0].voice.as_mut() {
        v.noise_on = false; v.gate_on = false; v.eq_on = false; v.comp_on = false; v.leveler_on = false; v.high_pass_hz = 10.0; v.comp_makeup_db = 0.0;
    }
    let processed = Profile::streaming();
    let (a, _, _) = render(&raw, secs);
    let (b, latency_ms, cpu) = render(&processed, secs);

    // second pass of the 6 s loop, after the suppressor has learned the room
    let at = |x: &[f32], from: f32, to: f32| x[(from * SR as f32) as usize..(to * SR as f32) as usize].to_vec();
    let report = |name: &str, x: &[f32]| {
        let voice = rms_db(&at(x, 6.0 + 3.9, 6.0 + 4.3));
        let hiss = rms_db(&at(x, 6.0 + 4.5, 6.0 + 4.85)); // gap between words (one keyboard click may land here)
        println!("{name:10} voice {voice:6.1} dB   background {hiss:6.1} dB   voice over background {:5.1} dB", voice - hiss);
    };
    println!("Synthetic noisy voice through the real engine (steady hiss, fan rumble, keyboard clicks)\n");
    report("original", &a);
    report("processed", &b);
    println!("\nadded delay {latency_ms:.1} ms (noise stage + input buffer), worst CPU load {cpu:.1}% of real time");
    write_wav(&std::path::Path::new(dir).join("mic_original.wav"), &a)?;
    write_wav(&std::path::Path::new(dir).join("mic_processed.wav"), &b)?;
    println!("wrote {dir}/mic_original.wav and {dir}/mic_processed.wav");
    Ok(())
}

/// Runs the engine in real time on the fake mic and answers JSON-line requests on stdin.
fn serve(dir: &str) {
    let profile = Profile::streaming();
    let parts = build(&profile);
    let mut inputs = parts.source_inputs;
    let mut outs = parts.dest_outputs;
    let mut engine = parts.engine;
    let mut server = Server::new(parts.handle, profile.clone(), Store::new(dir));
    server.apply_profile(profile).ok();
    std::thread::spawn(move || {
        let (mut mic, mut buf, mut sink) = (FakeMic::new(), Vec::new(), vec![0.0f32; BLOCK * 2]);
        loop {
            mic.block(BLOCK, &mut buf);
            inputs[0].push_slice(&buf);
            engine.process_block(BLOCK);
            for o in outs.iter_mut() { while o.pop_slice(&mut sink) > 0 {} }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        let r = server.handle_line(&line);
        let mut o = stdout.lock();
        let _ = writeln!(o, "{r}");
        let _ = o.flush();
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("simulate") => simulate(args.get(2).map(String::as_str).unwrap_or("out")).expect("simulation failed"),
        Some("serve") => serve(args.get(2).map(String::as_str).unwrap_or("profiles")),
        _ => eprintln!("usage: eddy-cli simulate [dir]   render a noisy voice raw vs processed to WAV files\n       eddy-cli serve [dir]      run the engine and answer JSON-line commands on stdin"),
    }
}
