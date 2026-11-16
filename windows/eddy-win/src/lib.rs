//! WASAPI backend. NOT yet compiled or run by its author: written without access to a
//! Windows machine. Expect small API mismatches against `windows` 0.58 on the first build.
#![cfg(windows)]

pub mod capture;
pub mod devices;
pub mod render;

#[cfg(feature = "process-loopback")]
pub mod process_loopback;
