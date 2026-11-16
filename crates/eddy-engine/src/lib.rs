//! The Eddy engine. Platform independent: capture and render backends push and pull
//! interleaved stereo `f32` through ring buffers, the engine does everything in between.

pub mod command;
pub mod drift;
pub mod engine;
pub mod ipc;
pub mod profile;
pub mod store;
pub mod telemetry;
pub mod voice;

pub const CHANNELS: usize = 2;
