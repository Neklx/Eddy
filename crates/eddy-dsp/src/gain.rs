/// A gain that ramps linearly to its target, so volume changes never click.
#[derive(Clone, Debug)]
pub struct SmoothedGain {
    current: f32,
    target: f32,
    step: f32,
    remaining: u32,
    ramp_samples: u32,
}

impl SmoothedGain {
    pub fn new(initial: f32, sample_rate: f32, ramp_ms: f32) -> Self {
        Self {
            current: initial,
            target: initial,
            step: 0.0,
            remaining: 0,
            ramp_samples: ((ramp_ms * 0.001 * sample_rate) as u32).max(1),
        }
    }

    pub fn set_target(&mut self, target: f32) {
        if (target - self.target).abs() < f32::EPSILON {
            return;
        }
        self.target = target;
        self.remaining = self.ramp_samples;
        self.step = (target - self.current) / self.remaining as f32;
    }

    pub fn target(&self) -> f32 {
        self.target
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            self.current = if self.remaining == 0 { self.target } else { self.current + self.step };
        }
        self.current
    }

    pub fn is_settled(&self) -> bool {
        self.remaining == 0
    }

    pub fn apply(&mut self, buf: &mut [f32]) {
        if self.is_settled() {
            let g = self.current;
            if (g - 1.0).abs() > f32::EPSILON {
                buf.iter_mut().for_each(|s| *s *= g);
            }
        } else {
            buf.iter_mut().for_each(|s| *s *= self.next());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ramps_without_jumps() {
        let mut g = SmoothedGain::new(1.0, 48_000.0, 10.0);
        g.set_target(0.0);
        let mut prev = g.next();
        let mut max_step = 0.0f32;
        for _ in 0..600 {
            let v = g.next();
            max_step = max_step.max((prev - v).abs());
            prev = v;
        }
        assert!(max_step < 0.01, "max step {max_step}");
        assert_eq!(g.next(), 0.0);
        assert!(g.is_settled());
    }
}
