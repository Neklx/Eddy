use eddy_ring::Consumer;

/// Reads interleaved stereo from a capture ring while absorbing clock drift between the
/// capture device and the render clock. It resamples by a ratio very close to 1.0, steered
/// by how full the ring is (a gentle proportional controller), using 4-point Catmull-Rom.
pub struct DriftReader {
    cons: Consumer<f32>,
    target_fill: usize, // frames
    hist: [[f32; 2]; 4],
    pos: f64,
    ratio: f64,
    primed: bool,
    pub underruns: u32,
    pub overruns: u32,
}

impl DriftReader {
    pub fn new(cons: Consumer<f32>, target_fill_frames: usize) -> Self {
        Self { cons, target_fill: target_fill_frames.max(16), hist: [[0.0; 2]; 4], pos: 1.0, ratio: 1.0, primed: false, underruns: 0, overruns: 0 }
    }

    pub fn fill_frames(&self) -> usize { self.cons.len() / 2 }
    pub fn ratio(&self) -> f64 { self.ratio }

    #[inline]
    fn pull(&mut self) -> bool {
        let mut f = [0.0f32; 2];
        let ok = self.cons.pop_slice(&mut f) == 2;
        let next = if ok { f } else { self.hist[3] };
        self.hist = [self.hist[1], self.hist[2], self.hist[3], next];
        ok
    }

    /// Fills `out` (interleaved stereo, even length). Returns false if the source ran dry.
    pub fn read(&mut self, out: &mut [f32]) -> bool {
        debug_assert!(out.len() % 2 == 0);
        let mut clean = true;
        if !self.primed {
            if self.fill_frames() < self.target_fill {
                out.iter_mut().for_each(|s| *s = 0.0);
                return true; // still buffering, not an underrun
            }
            for _ in 0..4 { self.pull(); }
            self.pos = 0.0;
            self.primed = true;
        }

        let fill = self.fill_frames();
        if fill > self.target_fill * 4 {
            // far too much queued (capture started long before, or the render stalled): trim
            self.cons.skip((fill - self.target_fill) * 2);
            self.overruns += 1;
        }
        let err = (self.fill_frames() as f64 - self.target_fill as f64) / self.target_fill as f64;
        self.ratio = 1.0 + (0.002 * err).clamp(-0.005, 0.005);

        for frame in out.chunks_exact_mut(2) {
            while self.pos >= 1.0 {
                if !self.pull() { clean = false; }
                self.pos -= 1.0;
            }
            let t = self.pos as f32;
            for c in 0..2 {
                let (y0, y1, y2, y3) = (self.hist[0][c], self.hist[1][c], self.hist[2][c], self.hist[3][c]);
                frame[c] = y1 + 0.5 * t * (y2 - y0 + t * (2.0 * y0 - 5.0 * y1 + 4.0 * y2 - y3 + t * (3.0 * (y1 - y2) + y3 - y0)));
            }
            self.pos += self.ratio;
        }
        if !clean { self.underruns += 1; }
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eddy_ring::ring;

    fn run(drift_ppm: f64, secs: usize) -> (u32, u32, usize, f32) {
        let (mut p, c) = ring::<f32>(48_000 * 2);
        let target = 960;
        let mut r = DriftReader::new(c, target);
        let (mut phase, mut owe) = (0.0f64, 0.0f64);
        let mut out = vec![0.0f32; 480 * 2];
        let mut max_jump = 0.0f32;
        let mut prev = 0.0f32;
        for _ in 0..(100 * secs) {
            // capture side delivers 480 frames per block, a little faster or slower than render
            owe += 480.0 * (1.0 + drift_ppm * 1e-6);
            let n = owe as usize;
            owe -= n as f64;
            let mut buf = Vec::with_capacity(n * 2);
            for _ in 0..n {
                let s = (phase * 2.0 * std::f64::consts::PI * 440.0 / 48_000.0).sin() as f32 * 0.5;
                phase += 1.0;
                buf.push(s);
                buf.push(s);
            }
            p.push_slice(&buf);
            r.read(&mut out);
            for f in out.chunks_exact(2) {
                if r.primed { max_jump = max_jump.max((f[0] - prev).abs()); }
                prev = f[0];
            }
        }
        (r.underruns, r.overruns, r.fill_frames(), max_jump)
    }

    #[test]
    fn stays_stable_with_fast_and_slow_capture_clocks() {
        for ppm in [-500.0, -100.0, 0.0, 100.0, 500.0] {
            let (under, over, fill, jump) = run(ppm, 30);
            assert_eq!(under, 0, "underruns at {ppm} ppm");
            assert_eq!(over, 0, "overruns at {ppm} ppm");
            // measured after the read, so about one block (480) below the pre-read target of 960
            assert!((fill as i64 - 480).abs() < 480, "fill {fill} at {ppm} ppm");
            assert!(jump < 0.1, "discontinuity {jump} at {ppm} ppm"); // 440 Hz at 0.5 amplitude changes at most ~0.03 per sample
        }
    }

    #[test]
    fn reports_underrun_when_source_stops() {
        let (mut p, c) = ring::<f32>(8192);
        let mut r = DriftReader::new(c, 480);
        p.push_slice(&vec![0.1f32; 480 * 2 + 40]);
        let mut out = vec![0.0f32; 960];
        assert!(r.read(&mut out));
        assert!(!r.read(&mut out), "second read has no data left");
        assert_eq!(r.underruns, 1);
    }
}
