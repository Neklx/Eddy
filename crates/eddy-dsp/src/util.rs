/// Decibels to linear amplitude.
#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Linear amplitude to decibels, floored at -120 dB so silence never gives -inf.
#[inline]
pub fn lin_to_db(lin: f32) -> f32 {
    20.0 * lin.max(1e-6).log10()
}

/// One-pole smoothing coefficient for a time constant in milliseconds.
#[inline]
pub fn time_coeff(ms: f32, sample_rate: f32) -> f32 {
    if ms <= 0.0 {
        0.0
    } else {
        (-1.0 / (ms * 0.001 * sample_rate)).exp()
    }
}
