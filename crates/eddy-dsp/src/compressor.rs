use crate::util::{db_to_lin, lin_to_db, time_coeff};

/// Feed-forward compressor with soft knee, computed in the dB domain.
#[derive(Clone, Debug)]
pub struct Compressor {
    sample_rate: f32,
    threshold_db: f32,
    ratio: f32,
    knee_db: f32,
    makeup_db: f32,
    attack_coeff: f32,
    release_coeff: f32,
    env_db: f32,
    last_reduction_db: f32,
}

impl Compressor {
    pub fn new(sample_rate: f32) -> Self {
        let mut c = Self {
            sample_rate,
            threshold_db: -18.0,
            ratio: 4.0,
            knee_db: 6.0,
            makeup_db: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            env_db: -120.0,
            last_reduction_db: 0.0,
        };
        c.set_times(10.0, 120.0);
        c
    }

    pub fn set_threshold_db(&mut self, db: f32) { self.threshold_db = db; }
    pub fn set_ratio(&mut self, r: f32) { self.ratio = r.max(1.0); }
    pub fn set_knee_db(&mut self, k: f32) { self.knee_db = k.max(0.0); }
    pub fn set_makeup_db(&mut self, m: f32) { self.makeup_db = m; }
    pub fn set_times(&mut self, attack_ms: f32, release_ms: f32) {
        self.attack_coeff = time_coeff(attack_ms, self.sample_rate);
        self.release_coeff = time_coeff(release_ms, self.sample_rate);
    }

    /// Gain reduction in dB (positive number) from the last block, for the UI meter.
    pub fn reduction_db(&self) -> f32 { self.last_reduction_db }

    #[inline]
    fn static_curve(&self, x_db: f32) -> f32 {
        let t = self.threshold_db;
        let w = self.knee_db;
        let slope = 1.0 / self.ratio - 1.0;
        if 2.0 * (x_db - t) < -w {
            x_db
        } else if 2.0 * (x_db - t).abs() <= w {
            x_db + slope * (x_db - t + w / 2.0).powi(2) / (2.0 * w)
        } else {
            t + (x_db - t) / self.ratio
        }
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        let makeup = db_to_lin(self.makeup_db);
        let mut max_red = 0.0f32;
        for s in buf.iter_mut() {
            let x_db = lin_to_db(s.abs());
            let target_red = x_db - self.static_curve(x_db); // >= 0
            let c = if target_red > self.env_db { self.attack_coeff } else { self.release_coeff };
            self.env_db = c * self.env_db + (1.0 - c) * target_red;
            max_red = max_red.max(self.env_db);
            *s *= db_to_lin(-self.env_db) * makeup;
        }
        self.last_reduction_db = max_red;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48_000.0).sin()).collect()
    }
    fn peak(x: &[f32]) -> f32 { x.iter().fold(0.0, |m, v| m.max(v.abs())) }

    #[test]
    fn reduces_loud_by_ratio_leaves_quiet() {
        let mut c = Compressor::new(48_000.0);
        c.set_threshold_db(-20.0);
        c.set_ratio(4.0);
        c.set_knee_db(0.0);
        c.set_times(1.0, 50.0);
        // 0 dBFS peak: 20 dB over, 4:1 gives 15 dB reduction, output near -15 dB
        let mut loud = sine(1.0, 48_000);
        c.process(&mut loud);
        let out_db = lin_to_db(peak(&loud[24_000..]));
        assert!((out_db + 15.0).abs() < 1.0, "got {out_db}");

        let mut c2 = Compressor::new(48_000.0);
        c2.set_threshold_db(-20.0);
        let mut quiet = sine(0.01, 48_000); // -40 dB, below threshold
        c2.process(&mut quiet);
        assert!((peak(&quiet[24_000..]) - 0.01).abs() < 0.001);
    }
}
