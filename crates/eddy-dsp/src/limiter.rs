use crate::util::{db_to_lin, time_coeff};

/// Safety limiter on outputs. Instant attack, smooth release; never exceeds the ceiling.
#[derive(Clone, Debug)]
pub struct Limiter {
    ceiling: f32,
    release: f32,
    gain: f32,
}

impl Limiter {
    pub fn new(sample_rate: f32, ceiling_db: f32) -> Self {
        Self { ceiling: db_to_lin(ceiling_db), release: time_coeff(80.0, sample_rate), gain: 1.0 }
    }

    pub fn process(&mut self, buf: &mut [f32]) {
        for s in buf.iter_mut() {
            let a = s.abs();
            // let the gain recover toward 1.0, then clamp so this very sample never exceeds the ceiling
            let mut g = self.release * self.gain + (1.0 - self.release);
            if a * g > self.ceiling {
                g = self.ceiling / a;
            }
            self.gain = g;
            *s *= self.gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_exceeds_ceiling() {
        let mut l = Limiter::new(48_000.0, -1.0);
        let mut x: Vec<f32> = (0..48_000).map(|i| 2.0 * (i as f32 * 0.05).sin()).collect();
        l.process(&mut x);
        let ceil = db_to_lin(-1.0);
        assert!(x.iter().all(|v| v.abs() <= ceil + 1e-6));
    }
    #[test]
    fn leaves_quiet_signal_alone() {
        let mut l = Limiter::new(48_000.0, -1.0);
        let mut x = vec![0.1f32; 1000];
        l.process(&mut x);
        assert!(x.iter().all(|v| (*v - 0.1).abs() < 1e-6));
    }
}
