use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FilterKind {
    Peaking { gain_db: f32 },
    LowShelf { gain_db: f32 },
    HighShelf { gain_db: f32 },
    HighPass,
    LowPass,
}

/// RBJ cookbook biquad, transposed direct form II. Coefficients in f64, state in f64
/// to stay stable for low-frequency filters.
#[derive(Clone, Debug)]
pub struct Biquad {
    b0: f64, b1: f64, b2: f64, a1: f64, a2: f64,
    z1: f64, z2: f64,
}

impl Biquad {
    pub fn new(kind: FilterKind, freq: f32, q: f32, sample_rate: f32) -> Self {
        let mut b = Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0 };
        b.set(kind, freq, q, sample_rate);
        b
    }

    pub fn set(&mut self, kind: FilterKind, freq: f32, q: f32, sample_rate: f32) {
        let fs = sample_rate as f64;
        let f0 = (freq as f64).clamp(10.0, fs * 0.49);
        let q = (q as f64).max(0.05);
        let w0 = 2.0 * PI * f0 / fs;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);

        let (b0, b1, b2, a0, a1, a2) = match kind {
            FilterKind::Peaking { gain_db } => {
                let a = 10f64.powf(gain_db as f64 / 40.0);
                (1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a)
            }
            FilterKind::LowShelf { gain_db } => {
                let a = 10f64.powf(gain_db as f64 / 40.0);
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - s),
                    (a + 1.0) + (a - 1.0) * cos + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - s,
                )
            }
            FilterKind::HighShelf { gain_db } => {
                let a = 10f64.powf(gain_db as f64 / 40.0);
                let s = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - s),
                    (a + 1.0) - (a - 1.0) * cos + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - s,
                )
            }
            FilterKind::HighPass => (
                (1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0,
                1.0 + alpha, -2.0 * cos, 1.0 - alpha,
            ),
            FilterKind::LowPass => (
                (1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0,
                1.0 + alpha, -2.0 * cos, 1.0 - alpha,
            ),
        };
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    #[inline]
    pub fn process_sample(&mut self, x: f32) -> f32 {
        let x = x as f64;
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y as f32
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        for s in buf.iter_mut() {
            *s = self.process_sample(*s);
        }
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// A chain of up to N bands, the building block of the parametric EQ screen.
#[derive(Clone, Debug)]
pub struct Equalizer {
    bands: Vec<Biquad>,
    enabled: Vec<bool>,
}

impl Equalizer {
    pub fn new() -> Self {
        Self { bands: Vec::new(), enabled: Vec::new() }
    }

    /// Control thread only (allocates). Build the chain, then hand it to the audio thread.
    pub fn add_band(&mut self, kind: FilterKind, freq: f32, q: f32, sample_rate: f32) -> usize {
        self.bands.push(Biquad::new(kind, freq, q, sample_rate));
        self.enabled.push(true);
        self.bands.len() - 1
    }

    pub fn set_band(&mut self, i: usize, kind: FilterKind, freq: f32, q: f32, sample_rate: f32) {
        if let Some(b) = self.bands.get_mut(i) {
            b.set(kind, freq, q, sample_rate);
        }
    }

    pub fn set_enabled(&mut self, i: usize, on: bool) {
        if let Some(e) = self.enabled.get_mut(i) {
            *e = on;
        }
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        for (b, on) in self.bands.iter_mut().zip(&self.enabled) {
            if *on {
                b.process(buf);
            }
        }
    }
}

impl Default for Equalizer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, fs: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / fs).sin()).collect()
    }
    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn peaking_boosts_center_frequency_by_gain() {
        let fs = 48_000.0;
        let mut f = Biquad::new(FilterKind::Peaking { gain_db: 6.0 }, 1000.0, 1.0, fs);
        let mut x = sine(1000.0, fs, 48_000);
        f.process(&mut x);
        let gain_db = 20.0 * (rms(&x[4800..]) / (1.0 / 2f32.sqrt())).log10();
        assert!((gain_db - 6.0).abs() < 0.2, "got {gain_db}");
    }

    #[test]
    fn highpass_cuts_rumble_keeps_voice() {
        let fs = 48_000.0;
        let mut hp = Biquad::new(FilterKind::HighPass, 100.0, 0.707, fs);
        let mut low = sine(30.0, fs, 48_000);
        hp.process(&mut low);
        let mut hp2 = Biquad::new(FilterKind::HighPass, 100.0, 0.707, fs);
        let mut mid = sine(1000.0, fs, 48_000);
        hp2.process(&mut mid);
        assert!(rms(&low[4800..]) < 0.08, "low {}", rms(&low[4800..]));
        assert!(rms(&mid[4800..]) > 0.69);
    }

    #[test]
    fn equalizer_bypassed_band_is_identity() {
        let mut eq = Equalizer::new();
        let i = eq.add_band(FilterKind::Peaking { gain_db: 12.0 }, 1000.0, 1.0, 48_000.0);
        eq.set_enabled(i, false);
        let mut x = sine(1000.0, 48_000.0, 1000);
        let y = x.clone();
        eq.process(&mut x);
        assert_eq!(x, y);
    }
}
