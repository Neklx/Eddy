//! Real-time DSP blocks for Eddy.
//!
//! Rules for everything in this crate:
//! - `process*` methods never allocate, lock, or block.
//! - Parameters are set from the control thread via `set_*` and smoothed internally.
//! - All blocks work on mono `f32` slices; stereo is two instances (or linked detectors).

pub mod biquad;
pub mod compressor;
pub mod fft;
pub mod gain;
pub mod gate;
pub mod leveler;
pub mod limiter;
pub mod meter;
pub mod mixer;
pub mod suppressor;
pub mod util;
