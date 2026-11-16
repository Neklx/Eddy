use crate::util::lin_to_db;

/// Peak meter with fall-off, plus peak hold, for the UI.
#[derive(Clone, Debug)]
pub struct Meter {
    peak: f32,
    hold: f32,
    hold_left: u32,
    hold_samples: u32,
    fall_per_sample: f32,
}

impl Meter {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            peak: 0.0,
            hold: 0.0,
            hold_left: 0,
            hold_samples: (sample_rate * 1.5) as u32,
            fall_per_sample: 20.0 / (sample_rate * 1.7), // roughly 20 dB per 1.7 s
        }
    }

    pub fn process(&mut self, buf: &[f32]) {
        let mut p_db = lin_to_db(self.peak);
        for s in buf {
            let a = lin_to_db(s.abs());
            if a > p_db { p_db = a } else { p_db -= self.fall_per_sample }
        }
        p_db = p_db.max(-120.0);
        self.peak = 10f32.powf(p_db / 20.0);
        let block_peak = buf.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        if block_peak >= self.hold {
            self.hold = block_peak;
            self.hold_left = self.hold_samples;
        } else if self.hold_left > buf.len() as u32 {
            self.hold_left -= buf.len() as u32;
        } else {
            self.hold = self.peak;
            self.hold_left = 0;
        }
    }

    pub fn peak_db(&self) -> f32 { lin_to_db(self.peak) }
    pub fn hold_db(&self) -> f32 { lin_to_db(self.hold) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_peak_and_falls() {
        let mut m = Meter::new(48_000.0);
        m.process(&[0.0, 0.5, 0.0]);
        assert!((m.peak_db() + 6.0).abs() < 0.1);
        m.process(&vec![0.0; 96_000]);
        assert!(m.peak_db() < -20.0);
    }
}
