use crate::util::{db_to_lin, lin_to_db, time_coeff};

/// Downward expander style noise gate with hold, so word endings are not chopped.
#[derive(Clone, Debug)]
pub struct Gate {
    sample_rate: f32,
    threshold_db: f32,
    range_db: f32,
    attack_coeff: f32,
    release_coeff: f32,
    hold_samples: u32,
    hold_left: u32,
    env: f32,
    gain: f32,
}

impl Gate {
    pub fn new(sample_rate: f32) -> Self {
        let mut g = Self {
            sample_rate,
            threshold_db: -50.0,
            range_db: -60.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            hold_samples: 0,
            hold_left: 0,
            env: 0.0,
            gain: 0.0,
        };
        g.set_times(5.0, 120.0, 80.0);
        g
    }

    pub fn set_threshold_db(&mut self, db: f32) { self.threshold_db = db; }
    pub fn set_range_db(&mut self, db: f32) { self.range_db = db.min(0.0); }

    pub fn set_times(&mut self, attack_ms: f32, release_ms: f32, hold_ms: f32) {
        self.attack_coeff = time_coeff(attack_ms, self.sample_rate);
        self.release_coeff = time_coeff(release_ms, self.sample_rate);
        self.hold_samples = (hold_ms * 0.001 * self.sample_rate) as u32;
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        let floor = db_to_lin(self.range_db);
        let thr = db_to_lin(self.threshold_db);
        // envelope follower runs fast up, slower down
        let env_up = time_coeff(1.0, self.sample_rate);
        let env_down = time_coeff(20.0, self.sample_rate);
        for s in buf.iter_mut() {
            let a = s.abs();
            let c = if a > self.env { env_up } else { env_down };
            self.env = c * self.env + (1.0 - c) * a;

            let open = self.env >= thr;
            if open {
                self.hold_left = self.hold_samples;
            } else if self.hold_left > 0 {
                self.hold_left -= 1;
            }
            let target = if open || self.hold_left > 0 { 1.0 } else { floor };
            let c = if target > self.gain { self.attack_coeff } else { self.release_coeff };
            self.gain = c * self.gain + (1.0 - c) * target;
            *s *= self.gain;
        }
    }

    pub fn current_gain_db(&self) -> f32 { lin_to_db(self.gain) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 48_000.0).sin()).collect()
    }
    fn peak(x: &[f32]) -> f32 { x.iter().fold(0.0, |m, v| m.max(v.abs())) }

    #[test]
    fn closes_on_quiet_noise_opens_on_voice() {
        let mut g = Gate::new(48_000.0);
        g.set_threshold_db(-40.0);
        let mut noise = sine(0.002, 48_000); // about -54 dB
        g.process(&mut noise);
        assert!(peak(&noise[24_000..]) < 0.0005, "noise leaked");

        let mut voice = sine(0.3, 48_000);
        g.process(&mut voice);
        assert!(peak(&voice[24_000..]) > 0.29, "voice attenuated");
    }

    #[test]
    fn hold_keeps_gate_open_briefly() {
        let mut g = Gate::new(48_000.0);
        g.set_threshold_db(-40.0);
        g.set_times(1.0, 50.0, 100.0);
        let mut voice = sine(0.3, 4800);
        g.process(&mut voice);
        let mut tail = sine(0.0, 2400); // 50 ms of silence, inside hold
        g.process(&mut tail);
        assert!(g.current_gain_db() > -1.0);
    }
}
