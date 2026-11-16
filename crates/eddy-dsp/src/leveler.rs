use crate::util::{db_to_lin, lin_to_db, time_coeff};

/// Slow automatic gain riding toward a target level. Holds the gain steady during
/// silence so it does not pump background noise up.
#[derive(Clone, Debug)]
pub struct AutoLeveler {
    target_db: f32,
    max_gain_db: f32,
    gate_db: f32,
    env_coeff_up: f32,
    env_coeff_down: f32,
    gain_up: f32,
    gain_down: f32,
    env: f32,
    gain_db: f32,
}

impl AutoLeveler {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            target_db: -16.0, max_gain_db: 12.0, gate_db: -50.0,
            env_coeff_up: time_coeff(5.0, sample_rate),
            env_coeff_down: time_coeff(300.0, sample_rate),
            gain_up: time_coeff(1500.0, sample_rate),
            gain_down: time_coeff(200.0, sample_rate),
            env: 0.0, gain_db: 0.0,
        }
    }
    pub fn set_target_db(&mut self, db: f32) { self.target_db = db; }
    pub fn set_max_gain_db(&mut self, db: f32) { self.max_gain_db = db.max(0.0); }
    pub fn gain_db(&self) -> f32 { self.gain_db }

    pub fn process(&mut self, buf: &mut [f32]) {
        for s in buf.iter_mut() {
            let a = s.abs();
            let c = if a > self.env { self.env_coeff_up } else { self.env_coeff_down };
            self.env = c * self.env + (1.0 - c) * a;
            let level_db = lin_to_db(self.env);
            if level_db > self.gate_db {
                let want = (self.target_db - level_db).clamp(-self.max_gain_db, self.max_gain_db);
                let c = if want < self.gain_db { self.gain_down } else { self.gain_up };
                self.gain_db = c * self.gain_db + (1.0 - c) * want;
            }
            *s *= db_to_lin(self.gain_db);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sine(amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * 200.0 * i as f32 / 48_000.0).sin()).collect()
    }
    fn rms_db(x: &[f32]) -> f32 { lin_to_db((x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()) }

    #[test]
    fn brings_quiet_voice_toward_target() {
        let mut l = AutoLeveler::new(48_000.0);
        let mut x = sine(0.05, 48_000 * 8); // about -29 dB rms
        l.process(&mut x);
        let tail = rms_db(&x[48_000 * 6..]);
        assert!(tail > -20.0, "tail {tail}");
    }

    #[test]
    fn does_not_raise_noise_floor() {
        let mut l = AutoLeveler::new(48_000.0);
        let mut x = sine(0.001, 48_000 * 4); // -63 dB, under the gate
        l.process(&mut x);
        assert!(l.gain_db().abs() < 0.01);
    }
}
