//! Noise suppression behind one trait, so RNNoise or DeepFilterNet can replace the
//! built-in spectral suppressor without touching the engine.

use crate::fft::Fft;
use std::f32::consts::PI;

pub trait NoiseSuppressor: Send {
    /// Samples consumed and produced per call.
    fn hop(&self) -> usize;
    /// Algorithmic delay in samples (for latency display).
    fn latency(&self) -> usize;
    fn set_strength(&mut self, strength: f32); // 0.0 .. 1.0
    fn process_hop(&mut self, input: &[f32], output: &mut [f32]);
}

/// Spectral-subtraction suppressor with a minimum-statistics style noise tracker.
/// Pure Rust, no model files. Quality is below RNNoise/DeepFilterNet; it is the
/// always-available fallback and the reference for tests.
pub struct SpectralSuppressor {
    n: usize,
    hop: usize,
    fft: Fft,
    window: Vec<f32>,
    in_buf: Vec<f32>,   // last n input samples
    ola: Vec<f32>,      // overlap-add accumulator (n)
    noise: Vec<f32>,    // per-bin noise power estimate
    gain_prev: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    strength: f32,
    frames_seen: u32,
}

impl SpectralSuppressor {
    pub fn new() -> Self {
        let n = 512;
        let hop = n / 2;
        // sqrt-Hann analysis and synthesis windows: perfect reconstruction at 50% overlap
        let window = (0..n).map(|i| (PI * (i as f32 + 0.5) / n as f32).sin()).collect();
        Self {
            n, hop, fft: Fft::new(n), window,
            in_buf: vec![0.0; n], ola: vec![0.0; n],
            noise: vec![0.0; n / 2 + 1], gain_prev: vec![1.0; n / 2 + 1],
            re: vec![0.0; n], im: vec![0.0; n],
            strength: 0.7, frames_seen: 0,
        }
    }
}

impl Default for SpectralSuppressor { fn default() -> Self { Self::new() } }

impl NoiseSuppressor for SpectralSuppressor {
    fn hop(&self) -> usize { self.hop }
    fn latency(&self) -> usize { self.n }
    fn set_strength(&mut self, s: f32) { self.strength = s.clamp(0.0, 1.0); }

    fn process_hop(&mut self, input: &[f32], output: &mut [f32]) {
        debug_assert_eq!(input.len(), self.hop);
        debug_assert_eq!(output.len(), self.hop);
        let (n, hop) = (self.n, self.hop);
        self.in_buf.copy_within(hop.., 0);
        self.in_buf[n - hop..].copy_from_slice(input);

        for i in 0..n {
            self.re[i] = self.in_buf[i] * self.window[i];
            self.im[i] = 0.0;
        }
        self.fft.forward(&mut self.re, &mut self.im);

        // strength maps to over-subtraction factor and gain floor
        let over = 1.0 + 3.0 * self.strength;
        let floor = 10f32.powf(-(6.0 + 24.0 * self.strength) / 20.0);
        for k in 0..=n / 2 {
            let p = self.re[k] * self.re[k] + self.im[k] * self.im[k];
            if self.frames_seen < 4 {
                self.noise[k] = if self.frames_seen == 0 { p } else { 0.5 * (self.noise[k] + p) };
            } else if p < 4.0 * self.noise[k] {
                // noise-like frame: average it in (tracks the mean noise power)
                self.noise[k] += (p - self.noise[k]) * 0.05;
            } else {
                // much louder than the estimate: probably speech, only creep upward
                self.noise[k] += (p - self.noise[k]) * 0.00003;
            }
            let raw = ((p - over * self.noise[k]) / p.max(1e-12)).max(0.0).sqrt().max(floor);
            // smooth gains over time to avoid musical noise
            let g = if raw > self.gain_prev[k] { 0.6 * self.gain_prev[k] + 0.4 * raw } else { 0.85 * self.gain_prev[k] + 0.15 * raw };
            self.gain_prev[k] = g;
            self.re[k] *= g;
            self.im[k] *= g;
            if k != 0 && k != n / 2 {
                self.re[n - k] = self.re[k];
                self.im[n - k] = -self.im[k];
            }
        }
        self.frames_seen = self.frames_seen.saturating_add(1);
        self.fft.inverse(&mut self.re, &mut self.im);

        for i in 0..n {
            self.ola[i] += self.re[i] * self.window[i];
        }
        output.copy_from_slice(&self.ola[..hop]);
        self.ola.copy_within(hop.., 0);
        self.ola[n - hop..].iter_mut().for_each(|v| *v = 0.0);
    }
}

/// Lets a fixed-hop suppressor run on arbitrary block sizes.
pub struct HopAdapter {
    inner: Box<dyn NoiseSuppressor>,
    in_q: Vec<f32>,
    out_q: Vec<f32>,
    in_len: usize,
    out_start: usize,
    out_len: usize,
    tmp_out: Vec<f32>,
}

impl HopAdapter {
    pub fn new(inner: Box<dyn NoiseSuppressor>, max_block: usize) -> Self {
        let hop = inner.hop();
        let cap = max_block + hop * 2;
        let mut a = Self { inner, in_q: vec![0.0; cap], out_q: vec![0.0; cap * 2], in_len: 0, out_start: 0, out_len: 0, tmp_out: vec![0.0; hop] };
        // prime the output with one hop of silence so output is never short
        a.out_len = hop;
        a
    }

    pub fn latency(&self) -> usize { self.inner.latency() + self.inner.hop() }
    pub fn set_strength(&mut self, s: f32) { self.inner.set_strength(s) }

    /// In-place; block length must not exceed `max_block` given at construction.
    pub fn process(&mut self, buf: &mut [f32]) {
        let hop = self.inner.hop();
        for chunk_start in (0..buf.len()).step_by(hop.max(1)) {
            let end = (chunk_start + hop).min(buf.len());
            let chunk = &buf[chunk_start..end];
            self.in_q[self.in_len..self.in_len + chunk.len()].copy_from_slice(chunk);
            self.in_len += chunk.len();
            while self.in_len >= hop {
                let (a, b) = (&self.in_q[..hop], &mut self.tmp_out[..]);
                self.inner.process_hop(a, b);
                self.in_q.copy_within(hop..self.in_len, 0);
                self.in_len -= hop;
                if self.out_start + self.out_len + hop > self.out_q.len() {
                    self.out_q.copy_within(self.out_start..self.out_start + self.out_len, 0);
                    self.out_start = 0;
                }
                let o = self.out_start + self.out_len;
                self.out_q[o..o + hop].copy_from_slice(&self.tmp_out);
                self.out_len += hop;
            }
        }
        let take = buf.len().min(self.out_len);
        let missing = buf.len() - take;
        buf[..missing].iter_mut().for_each(|v| *v = 0.0);
        buf[missing..].copy_from_slice(&self.out_q[self.out_start..self.out_start + take]);
        self.out_start += take;
        self.out_len -= take;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lcg(u32);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
            (self.0 >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        }
    }
    fn rms(x: &[f32]) -> f32 { (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt() }

    #[test]
    fn removes_steady_noise_keeps_tone() {
        let mut rng = Lcg(1);
        let fs = 48_000.0;
        let secs = 4;
        let n = 48_000 * secs;
        // noise throughout, a 440 Hz "voice" from second 2 onward
        let sig: Vec<f32> = (0..n).map(|i| {
            let noise = 0.02 * rng.next();
            let tone = if i >= 96_000 { 0.3 * (2.0 * PI * 440.0 * i as f32 / fs).sin() } else { 0.0 };
            noise + tone
        }).collect();
        let mut s = HopAdapter::new(Box::new(SpectralSuppressor::new()), 480);
        s.set_strength(0.8);
        let mut out = sig.clone();
        for c in out.chunks_mut(480) { s.process(c); }

        let noise_in = rms(&sig[48_000..96_000]);
        let noise_out = rms(&out[48_000..96_000]);
        let reduction_db = 20.0 * (noise_in / noise_out).log10();
        assert!(reduction_db > 10.0, "noise reduction {reduction_db} dB");

        let tone_in = rms(&sig[150_000..190_000]);
        let tone_out = rms(&out[150_000..190_000]);
        let loss_db = 20.0 * (tone_in / tone_out).log10();
        assert!(loss_db.abs() < 2.0, "tone changed by {loss_db} dB");
    }

    #[test]
    fn passes_signal_when_strength_zero_ish() {
        let mut s = SpectralSuppressor::new();
        s.set_strength(0.0);
        assert_eq!(s.hop(), 256);
        assert!(s.latency() >= s.hop());
    }
}
