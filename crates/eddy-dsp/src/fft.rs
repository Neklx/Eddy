use std::f32::consts::PI;

/// In-place radix-2 complex FFT. Tables are built once in `new` (control thread).
pub struct Fft {
    n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
    rev: Vec<usize>,
}

impl Fft {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two() && n >= 2);
        let bits = n.trailing_zeros();
        let rev = (0..n).map(|i| i.reverse_bits() >> (usize::BITS - bits)).collect();
        let cos = (0..n / 2).map(|k| (2.0 * PI * k as f32 / n as f32).cos()).collect();
        let sin = (0..n / 2).map(|k| -(2.0 * PI * k as f32 / n as f32).sin()).collect();
        Self { n, cos, sin, rev }
    }

    pub fn len(&self) -> usize { self.n }

    fn run(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        let n = self.n;
        for i in 0..n {
            let j = self.rev[i];
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= n {
            let half = size / 2;
            let step = n / size;
            for start in (0..n).step_by(size) {
                for k in 0..half {
                    let wr = self.cos[k * step];
                    let wi = if inverse { -self.sin[k * step] } else { self.sin[k * step] };
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            size <<= 1;
        }
        if inverse {
            let s = 1.0 / n as f32;
            re.iter_mut().for_each(|v| *v *= s);
            im.iter_mut().for_each(|v| *v *= s);
        }
    }

    pub fn forward(&self, re: &mut [f32], im: &mut [f32]) { self.run(re, im, false) }
    pub fn inverse(&self, re: &mut [f32], im: &mut [f32]) { self.run(re, im, true) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_peak_bin() {
        let n = 256;
        let f = Fft::new(n);
        let orig: Vec<f32> = (0..n).map(|i| (2.0 * PI * 8.0 * i as f32 / n as f32).sin()).collect();
        let mut re = orig.clone();
        let mut im = vec![0.0; n];
        f.forward(&mut re, &mut im);
        let mag: Vec<f32> = (0..n / 2).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt()).collect();
        let peak = mag.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap().0;
        assert_eq!(peak, 8);
        f.inverse(&mut re, &mut im);
        for (a, b) in re.iter().zip(&orig) {
            assert!((a - b).abs() < 1e-4);
        }
    }
}
