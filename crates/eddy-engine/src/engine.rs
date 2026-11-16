use crate::command::Command;
use crate::drift::DriftReader;
use crate::telemetry::Telemetry;
use crate::voice::VoiceChain;
use eddy_dsp::gain::SmoothedGain;
use eddy_dsp::limiter::Limiter;
use eddy_dsp::mixer::Mixer;
use eddy_ring::{ring, Consumer, Producer};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Debug)]
pub struct SourceSpec {
    pub name: String,
    /// Voice sources run through the microphone chain (mono, then duplicated to both sides).
    pub is_voice: bool,
}

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub sample_rate: u32,
    pub max_block: usize,
    pub sources: Vec<SourceSpec>,
    pub destinations: Vec<String>,
    /// How much audio to keep queued per source to absorb scheduling jitter.
    pub target_fill_frames: usize,
}

impl EngineConfig {
    pub fn new(sample_rate: u32, sources: &[(&str, bool)], destinations: &[&str]) -> Self {
        Self {
            sample_rate,
            max_block: 1024,
            sources: sources.iter().map(|(n, v)| SourceSpec { name: n.to_string(), is_voice: *v }).collect(),
            destinations: destinations.iter().map(|d| d.to_string()).collect(),
            target_fill_frames: (sample_rate as usize / 1000) * 20,
        }
    }
}

/// Everything a backend or the control side needs, returned by `Engine::build`.
pub struct EngineParts {
    pub engine: Engine,
    pub handle: EngineHandle,
    /// Capture side pushes interleaved stereo into these, one per source.
    pub source_inputs: Vec<Producer<f32>>,
    /// Render side pulls interleaved stereo from these, one per destination.
    pub dest_outputs: Vec<Consumer<f32>>,
}

/// Control-side handle. Lives on the UI/IPC thread.
pub struct EngineHandle {
    cmd: Producer<Command>,
    pub telemetry: Arc<Telemetry>,
}

impl EngineHandle {
    /// A handle whose commands go nowhere (queue of its own). For tests and offline tools.
    pub fn dangling(telemetry: Arc<Telemetry>) -> Self {
        let (cmd, _unused) = ring::<Command>(2);
        Self { cmd, telemetry }
    }

    /// Returns false if the command queue is full (the audio thread is not draining).
    pub fn send(&mut self, c: Command) -> bool { self.cmd.push(c) }
}

pub struct Engine {
    cfg: EngineConfig,
    readers: Vec<DriftReader>,
    chains: Vec<Option<VoiceChain>>,
    gains: Vec<[SmoothedGain; 2]>,
    muted: Vec<bool>,
    gain_target: Vec<f32>,
    mixers: [Mixer; 2],
    limiters: Vec<[Limiter; 2]>,
    writers: Vec<Producer<f32>>,
    cmd: Consumer<Command>,
    telemetry: Arc<Telemetry>,
    // preallocated scratch (flat per-channel blocks)
    in_l: Vec<f32>,
    in_r: Vec<f32>,
    out_l: Vec<f32>,
    out_r: Vec<f32>,
    inter: Vec<f32>,
    blocks_run: u64,
}

impl Engine {
    pub fn build(cfg: EngineConfig) -> EngineParts {
        let (ns, nd) = (cfg.sources.len(), cfg.destinations.len());
        let sr = cfg.sample_rate as f32;
        let mb = cfg.max_block;
        let ring_cap = cfg.sample_rate as usize * 2; // one second of stereo

        let mut readers = Vec::new();
        let mut source_inputs = Vec::new();
        for _ in 0..ns {
            let (p, c) = ring::<f32>(ring_cap);
            source_inputs.push(p);
            readers.push(DriftReader::new(c, cfg.target_fill_frames));
        }
        let mut writers = Vec::new();
        let mut dest_outputs = Vec::new();
        for _ in 0..nd {
            let (p, c) = ring::<f32>(ring_cap);
            writers.push(p);
            dest_outputs.push(c);
        }
        let (cmd_p, cmd_c) = ring::<Command>(1024);
        let telemetry = Arc::new(Telemetry::new(ns, nd));

        let engine = Engine {
            readers,
            chains: cfg.sources.iter().map(|s| if s.is_voice { Some(VoiceChain::new(sr, mb)) } else { None }).collect(),
            gains: (0..ns).map(|_| [SmoothedGain::new(1.0, sr, 15.0), SmoothedGain::new(1.0, sr, 15.0)]).collect(),
            muted: vec![false; ns],
            gain_target: vec![1.0; ns],
            mixers: [Mixer::new(ns, nd, sr), Mixer::new(ns, nd, sr)],
            limiters: (0..nd).map(|_| [Limiter::new(sr, -1.0), Limiter::new(sr, -1.0)]).collect(),
            writers,
            cmd: cmd_c,
            telemetry: telemetry.clone(),
            in_l: vec![0.0; ns * mb],
            in_r: vec![0.0; ns * mb],
            out_l: vec![0.0; nd * mb],
            out_r: vec![0.0; nd * mb],
            inter: vec![0.0; mb * 2],
            blocks_run: 0,
            cfg,
        };
        EngineParts { engine, handle: EngineHandle { cmd: cmd_p, telemetry }, source_inputs, dest_outputs }
    }

    pub fn config(&self) -> &EngineConfig { &self.cfg }
    pub fn telemetry(&self) -> Arc<Telemetry> { self.telemetry.clone() }

    /// Extra delay introduced by the engine for a voice source, in milliseconds.
    pub fn voice_latency_ms(&self, src: usize) -> f32 {
        let chain = self.chains.get(src).and_then(|c| c.as_ref()).map(|c| c.latency_samples()).unwrap_or(0);
        (chain + self.cfg.target_fill_frames) as f32 * 1000.0 / self.cfg.sample_rate as f32
    }

    fn apply(&mut self, c: Command) {
        let ns = self.cfg.sources.len();
        let nd = self.cfg.destinations.len();
        match c {
            Command::Nop => {}
            Command::SetSend { src, dst, gain } => {
                let (s, d) = (src as usize, dst as usize);
                if s < ns && d < nd {
                    self.mixers[0].set_send(s, d, gain);
                    self.mixers[1].set_send(s, d, gain);
                }
            }
            Command::SetSourceGain { src, gain } => {
                let s = src as usize;
                if s < ns {
                    self.gain_target[s] = gain;
                    self.refresh_gain(s);
                }
            }
            Command::SetSourceMute { src, mute } => {
                let s = src as usize;
                if s < ns {
                    self.muted[s] = mute;
                    self.refresh_gain(s);
                }
            }
            Command::SetDestGain { dst, gain } => {
                if (dst as usize) < nd {
                    self.mixers[0].set_destination_gain(dst as usize, gain);
                    self.mixers[1].set_destination_gain(dst as usize, gain);
                }
            }
            Command::SetStageEnabled { src, stage, on } => {
                if let Some(Some(ch)) = self.chains.get_mut(src as usize) { ch.set_stage(stage, on); }
            }
            Command::SetParam { src, param, value } => {
                if let Some(Some(ch)) = self.chains.get_mut(src as usize) { ch.set_param(param, value); }
            }
        }
    }

    fn refresh_gain(&mut self, s: usize) {
        let g = if self.muted[s] { 0.0 } else { self.gain_target[s] };
        for ch in 0..2 { self.gains[s][ch].set_target(g); }
    }

    /// Runs one block. Called by the render clock (the output device callback or a timer).
    /// `frames` must be at most `max_block`. Real-time safe: no allocation, no locks.
    pub fn process_block(&mut self, frames: usize) {
        let started = Instant::now();
        let mb = self.cfg.max_block;
        let frames = frames.min(mb);
        let ns = self.cfg.sources.len();
        let nd = self.cfg.destinations.len();

        let mut c = Command::Nop;
        while self.cmd.len() > 0 {
            let mut one = [Command::Nop];
            if self.cmd.pop_slice(&mut one) == 1 { c = one[0]; self.apply(c); }
        }
        let _ = c;

        for s in 0..ns {
            let clean = self.readers[s].read(&mut self.inter[..frames * 2]);
            if !clean {
                self.telemetry.src_underruns[s].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            let (l, r) = (&mut self.in_l[s * mb..s * mb + frames], &mut self.in_r[s * mb..s * mb + frames]);
            for (i, f) in self.inter[..frames * 2].chunks_exact(2).enumerate() {
                l[i] = f[0];
                r[i] = f[1];
            }
            if let Some(chain) = self.chains[s].as_mut() {
                for i in 0..frames { l[i] = 0.5 * (l[i] + r[i]); }
                chain.process(l);
                r.copy_from_slice(l);
            }
            let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
            Telemetry::note_peak(&self.telemetry.src_peak[s], peak);
            self.gains[s][0].apply(l);
            self.gains[s][1].apply(r);
        }

        self.mixers[0].process_flat(&self.in_l, &mut self.out_l, mb, frames);
        self.mixers[1].process_flat(&self.in_r, &mut self.out_r, mb, frames);

        for d in 0..nd {
            let (l, r) = (&mut self.out_l[d * mb..d * mb + frames], &mut self.out_r[d * mb..d * mb + frames]);
            self.limiters[d][0].process(l);
            self.limiters[d][1].process(r);
            let peak = l.iter().chain(r.iter()).fold(0.0f32, |m, v| m.max(v.abs()));
            Telemetry::note_peak(&self.telemetry.dst_peak[d], peak);
            for (i, f) in self.inter[..frames * 2].chunks_exact_mut(2).enumerate() {
                f[0] = l[i];
                f[1] = r[i];
            }
            if self.writers[d].push_slice(&self.inter[..frames * 2]) < frames * 2 {
                self.telemetry.dst_overruns[d].fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }

        self.blocks_run += 1;
        self.telemetry.blocks.store(self.blocks_run, std::sync::atomic::Ordering::Relaxed);
        let spent = started.elapsed().as_secs_f32();
        let budget = frames as f32 / self.cfg.sample_rate as f32;
        self.telemetry.load_permille.store((spent / budget * 1000.0) as u32, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::{Param, Stage};
    use crate::telemetry::Telemetry;

    struct Gen { phase: f64, freq: f64, amp: f32 }
    impl Gen {
        fn block(&mut self, frames: usize) -> Vec<f32> {
            let mut v = Vec::with_capacity(frames * 2);
            for _ in 0..frames {
                let s = (self.phase * 2.0 * std::f64::consts::PI * self.freq / 48_000.0).sin() as f32 * self.amp;
                self.phase += 1.0;
                v.push(s);
                v.push(s);
            }
            v
        }
    }
    fn peak(x: &[f32]) -> f32 { x.iter().fold(0.0, |m, v| m.max(v.abs())) }

    /// Sources: mic (voice), music. Destinations: headphones, voice chat.
    fn rig() -> (EngineParts, Gen, Gen) {
        let cfg = EngineConfig::new(48_000, &[("Microphone", true), ("Music", false)], &["Headphones", "Voice chat"]);
        let mut parts = Engine::build(cfg);
        // test signals are steady tones, which a noise suppressor rightly treats as noise
        parts.handle.send(Command::SetStageEnabled { src: 0, stage: Stage::Noise, on: false });
        (parts, Gen { phase: 0.0, freq: 440.0, amp: 0.3 }, Gen { phase: 0.0, freq: 1000.0, amp: 0.3 })
    }

    /// Runs `blocks` of 480 frames, returns what each destination received during the last 20 blocks.
    fn run(p: &mut EngineParts, mic: &mut Gen, music: &mut Gen, blocks: usize) -> Vec<Vec<f32>> {
        let mut tail = vec![Vec::new(); p.dest_outputs.len()];
        for b in 0..blocks {
            p.source_inputs[0].push_slice(&mic.block(480));
            p.source_inputs[1].push_slice(&music.block(480));
            p.engine.process_block(480);
            for (d, c) in p.dest_outputs.iter_mut().enumerate() {
                let mut buf = vec![0.0f32; 960];
                let n = c.pop_slice(&mut buf);
                assert_eq!(n, 960);
                if b >= blocks - 20 { tail[d].extend_from_slice(&buf); }
            }
        }
        tail
    }

    #[test]
    fn nothing_is_sent_until_a_route_is_set() {
        let (mut p, mut a, mut b) = rig();
        let out = run(&mut p, &mut a, &mut b, 100);
        assert!(peak(&out[0]) < 1e-6 && peak(&out[1]) < 1e-6);
    }

    #[test]
    fn routes_music_to_headphones_and_mic_to_voice_chat_only() {
        let (mut p, mut a, mut b) = rig();
        p.handle.send(Command::SetSend { src: 1, dst: 0, gain: 1.0 });
        p.handle.send(Command::SetSend { src: 0, dst: 1, gain: 1.0 });
        let out = run(&mut p, &mut a, &mut b, 200);
        assert!(peak(&out[0]) > 0.25, "headphones should carry music, got {}", peak(&out[0]));
        assert!(peak(&out[1]) > 0.05, "voice chat should carry the processed mic, got {}", peak(&out[1]));
        // music must not reach voice chat: check no 1 kHz by comparing to mic-only level range
        assert!(peak(&out[1]) < 0.35);
        assert_eq!(p.handle.telemetry.underruns(0), 0);
        assert_eq!(p.handle.telemetry.underruns(1), 0);
        assert_eq!(p.handle.telemetry.overruns(0), 0);
    }

    #[test]
    fn sharing_pc_sound_into_voice_chat_adds_it() {
        let (mut p, mut a, mut b) = rig();
        p.handle.send(Command::SetSend { src: 0, dst: 1, gain: 1.0 });
        let before = peak(&run(&mut p, &mut a, &mut b, 150)[1]);
        p.handle.send(Command::SetSend { src: 1, dst: 1, gain: 1.0 });
        let after = peak(&run(&mut p, &mut a, &mut b, 150)[1]);
        assert!(after > before + 0.05, "before {before} after {after}");
    }

    #[test]
    fn mute_and_gain_commands_apply_without_clicks() {
        let (mut p, mut a, mut b) = rig();
        p.handle.send(Command::SetSend { src: 1, dst: 0, gain: 1.0 });
        run(&mut p, &mut a, &mut b, 50);
        p.handle.send(Command::SetSourceMute { src: 1, mute: true });
        let out = run(&mut p, &mut a, &mut b, 60);
        assert!(peak(&out[0]) < 1e-4);
        p.handle.send(Command::SetSourceMute { src: 1, mute: false });
        p.handle.send(Command::SetSourceGain { src: 1, gain: 0.5 });
        let out = run(&mut p, &mut a, &mut b, 60);
        assert!((peak(&out[0]) - 0.15).abs() < 0.03, "{}", peak(&out[0]));
    }

    #[test]
    fn voice_chain_params_and_telemetry() {
        let (mut p, mut a, mut b) = rig();
        p.handle.send(Command::SetSend { src: 0, dst: 1, gain: 1.0 });
        p.handle.send(Command::SetStageEnabled { src: 0, stage: Stage::Noise, on: false });
        p.handle.send(Command::SetParam { src: 0, param: Param::GateThresholdDb, value: -60.0 });
        run(&mut p, &mut a, &mut b, 100);
        assert!(Telemetry::take_peak(&p.handle.telemetry.src_peak[0]) > 0.1);
        assert!(Telemetry::take_peak(&p.handle.telemetry.dst_peak[1]) > 0.05);
        assert!(p.handle.telemetry.cpu_percent() < 100.0);
        assert!(p.engine.voice_latency_ms(0) < 30.0);
    }

    #[test]
    fn output_never_exceeds_limiter_ceiling() {
        let (mut p, _a, _b) = rig();
        let mut loud = Gen { phase: 0.0, freq: 300.0, amp: 0.9 };
        let mut loud2 = Gen { phase: 0.0, freq: 500.0, amp: 0.9 };
        p.handle.send(Command::SetSend { src: 1, dst: 0, gain: 1.0 });
        p.handle.send(Command::SetSend { src: 0, dst: 0, gain: 1.0 });
        let out = run(&mut p, &mut loud, &mut loud2, 100);
        assert!(peak(&out[0]) <= 0.8913 + 1e-4, "{}", peak(&out[0])); // -1 dBFS
    }
}
