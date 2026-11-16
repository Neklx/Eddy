use std::sync::atomic::{AtomicU32, AtomicU64, Ordering::Relaxed};

/// Numbers the UI reads while the audio thread writes. Peaks are stored as the bit
/// pattern of a non-negative f32, which orders the same as the float, so `fetch_max` works.
pub struct Telemetry {
    pub src_peak: Vec<AtomicU32>,
    pub dst_peak: Vec<AtomicU32>,
    pub src_underruns: Vec<AtomicU32>,
    pub dst_overruns: Vec<AtomicU32>,
    pub blocks: AtomicU64,
    /// Time spent processing as a fraction of block duration, in thousandths.
    pub load_permille: AtomicU32,
}

impl Telemetry {
    pub fn new(n_src: usize, n_dst: usize) -> Self {
        let v = |n| (0..n).map(|_| AtomicU32::new(0)).collect::<Vec<_>>();
        Self { src_peak: v(n_src), dst_peak: v(n_dst), src_underruns: v(n_src), dst_overruns: v(n_dst), blocks: AtomicU64::new(0), load_permille: AtomicU32::new(0) }
    }

    pub fn note_peak(slot: &AtomicU32, peak: f32) { slot.fetch_max(peak.to_bits(), Relaxed); }

    /// Highest peak since the last call, then resets. Call at UI frame rate.
    pub fn take_peak(slot: &AtomicU32) -> f32 { f32::from_bits(slot.swap(0, Relaxed)) }

    pub fn cpu_percent(&self) -> f32 { self.load_permille.load(Relaxed) as f32 / 10.0 }
    pub fn underruns(&self, src: usize) -> u32 { self.src_underruns[src].load(Relaxed) }
    pub fn overruns(&self, dst: usize) -> u32 { self.dst_overruns[dst].load(Relaxed) }
}
