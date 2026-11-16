//! Capture: a microphone, or loopback of a render device ("System sound").
//! Shared mode, event driven, asks Windows to convert to 48 kHz stereo float so the
//! engine only ever sees one format. Pushes into the engine's source ring.

use crate::devices::{com_init, open};
use eddy_ring::Producer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows::Win32::Foundation::{WAIT_OBJECT_0, HANDLE};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Threading::*;

pub(crate) fn stereo_f32_48k() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: 2,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 8,
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

pub(crate) fn boost_thread() {
    unsafe {
        let mut index = 0u32;
        let name: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
        let _ = AvSetMmThreadCharacteristicsW(windows::core::PCWSTR(name.as_ptr()), &mut index);
    }
}

/// `loopback = true` captures what a render device is playing instead of a microphone.
pub fn spawn(device_id: Option<String>, loopback: bool, mut out: Producer<f32>, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<Result<(), String>> {
    std::thread::spawn(move || run(device_id, loopback, &mut out, &stop).map_err(|e| e.to_string()))
}

fn run(device_id: Option<String>, loopback: bool, out: &mut Producer<f32>, stop: &AtomicBool) -> windows::core::Result<()> {
    com_init()?;
    boost_thread();
    unsafe {
        let device = open(device_id.as_deref(), loopback)?;
        let client: IAudioClient = device.Activate(windows::Win32::System::Com::CLSCTX_ALL, None)?;
        let wf = stereo_f32_48k();
        let mut flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        if loopback { flags |= AUDCLNT_STREAMFLAGS_LOOPBACK; }
        // 20 ms buffer, in 100 ns units
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200_000, 0, &wf, None)?;
        let event: HANDLE = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let silent = vec![0.0f32; 48_000]; // up to one second of silence for SILENT packets
        while !stop.load(Ordering::Relaxed) {
            if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 { continue; } // timeout: loopback is silent when nothing plays
            loop {
                let packet = capture.GetNextPacketSize()?;
                if packet == 0 { break; }
                let (mut data, mut frames, mut bflags) = (std::ptr::null_mut(), 0u32, 0u32);
                capture.GetBuffer(&mut data, &mut frames, &mut bflags, None, None)?;
                let n = frames as usize * 2;
                if bflags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    out.push_slice(&silent[..n.min(silent.len())]);
                } else {
                    out.push_slice(std::slice::from_raw_parts(data as *const f32, n));
                }
                capture.ReleaseBuffer(frames)?;
            }
        }
        client.Stop()?;
    }
    Ok(())
}
