use crate::gain::SmoothedGain;

/// The routing matrix behind the main screen: N sources x M destinations,
/// each crossing has its own smoothed gain (0.0 means "not sent").
///
/// Buffers are planar mono. Stereo means running one Mixer per channel
/// with the same control values, or interleaving above this layer.
pub struct Mixer {
    n_src: usize,
    n_dst: usize,
    gains: Vec<SmoothedGain>, // [src * n_dst + dst]
    dest_gain: Vec<SmoothedGain>,
}

impl Mixer {
    pub fn new(n_src: usize, n_dst: usize, sample_rate: f32) -> Self {
        let ramp = 15.0;
        Self {
            n_src,
            n_dst,
            gains: (0..n_src * n_dst).map(|_| SmoothedGain::new(0.0, sample_rate, ramp)).collect(),
            dest_gain: (0..n_dst).map(|_| SmoothedGain::new(1.0, sample_rate, ramp)).collect(),
        }
    }

    pub fn set_send(&mut self, src: usize, dst: usize, gain: f32) {
        if src < self.n_src && dst < self.n_dst {
            self.gains[src * self.n_dst + dst].set_target(gain);
        }
    }

    pub fn send(&self, src: usize, dst: usize) -> f32 {
        self.gains[src * self.n_dst + dst].target()
    }

    pub fn set_destination_gain(&mut self, dst: usize, gain: f32) {
        if let Some(g) = self.dest_gain.get_mut(dst) {
            g.set_target(gain);
        }
    }

    /// Mix `inputs` into `outputs`. All slices must have the same length.
    /// Outputs are overwritten.
    pub fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]]) {
        debug_assert_eq!(inputs.len(), self.n_src);
        debug_assert_eq!(outputs.len(), self.n_dst);
        for (d, out) in outputs.iter_mut().enumerate() {
            out.iter_mut().for_each(|s| *s = 0.0);
            for (s, inp) in inputs.iter().enumerate() {
                let g = &mut self.gains[s * self.n_dst + d];
                if g.is_settled() && g.target() == 0.0 {
                    continue; // not sent: no work, no allocation
                }
                for (o, i) in out.iter_mut().zip(inp.iter()) {
                    *o += *i * g.next();
                }
            }
            self.dest_gain[d].apply(out);
        }
    }
}

impl Mixer {
    /// Allocation-free variant for the engine. `inputs` holds n_src blocks back to back
    /// (`inputs[s * block ..][..frames]`), `outputs` holds n_dst blocks the same way.
    pub fn process_flat(&mut self, inputs: &[f32], outputs: &mut [f32], block: usize, frames: usize) {
        for d in 0..self.n_dst {
            let out = &mut outputs[d * block..d * block + frames];
            out.iter_mut().for_each(|s| *s = 0.0);
            for s in 0..self.n_src {
                let g = &mut self.gains[s * self.n_dst + d];
                if g.is_settled() && g.target() == 0.0 {
                    continue;
                }
                let inp = &inputs[s * block..s * block + frames];
                for (o, i) in out.iter_mut().zip(inp.iter()) {
                    *o += *i * g.next();
                }
            }
            self.dest_gain[d].apply(out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_only_where_sent() {
        let mut m = Mixer::new(2, 2, 48_000.0);
        // mic -> voice chat only; music -> headphones only
        m.set_send(0, 1, 1.0);
        m.set_send(1, 0, 1.0);
        let mic = vec![0.5f32; 4800];
        let music = vec![0.25f32; 4800];
        let mut hp = vec![0.0f32; 4800];
        let mut chat = vec![0.0f32; 4800];
        m.process(&[&mic, &music], &mut [&mut hp, &mut chat]);
        assert!((hp[4799] - 0.25).abs() < 1e-5);
        assert!((chat[4799] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn sharing_pc_sound_adds_to_mic_bus() {
        let mut m = Mixer::new(2, 1, 48_000.0);
        m.set_send(0, 0, 1.0);
        m.set_send(1, 0, 0.5);
        let mic = vec![0.2f32; 4800];
        let pc = vec![0.4f32; 4800];
        let mut out = vec![0.0f32; 4800];
        m.process(&[&mic, &pc], &mut [&mut out]);
        assert!((out[4799] - 0.4).abs() < 1e-5);
    }

    #[test]
    fn toggling_a_send_does_not_click() {
        let mut m = Mixer::new(1, 1, 48_000.0);
        m.set_send(0, 0, 1.0);
        let x = vec![1.0f32; 4800];
        let mut out = vec![0.0f32; 4800];
        m.process(&[&x], &mut [&mut out]);
        m.set_send(0, 0, 0.0);
        m.process(&[&x], &mut [&mut out]);
        let max_jump = out.windows(2).map(|w| (w[0] - w[1]).abs()).fold(0.0, f32::max);
        assert!(max_jump < 0.01, "jump {max_jump}");
    }
}
