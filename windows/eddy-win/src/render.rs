//! Render: plays a destination to an output device.
//!
//! One renderer is the clock master. Its device event drives `Engine::process_block`.
//! Every other renderer (for example the virtual mic cable) runs on its own device clock
//! and reads its destination through a `DriftReader`, which absorbs the clock difference.

use crate::capture::{boost_thread, stereo_f32_48k};
use crate::devices::{com_init, open};
use eddy_engine::drift::DriftReader;
use eddy_engine::engine::Engine;
use eddy_ring::Consumer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Threading::*;

pub enum Role {
    /// Drives the engine from this device's clock and reads its own destination directly.
    Master { engine: Box<Engine>, dest: Consumer<f32> },
    /// Reads a destination at its own pace through drift correction.
    Follower { reader: DriftReader },
}

pub fn spawn(device_id: Option<String>, role: Role, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<Result<(), String>> {
    std::thread::spawn(move || run(device_id, role, &stop).map_err(|e| e.to_string()))
}

fn run(device_id: Option<String>, mut role: Role, stop: &AtomicBool) -> windows::core::Result<()> {
    com_init()?;
    boost_thread();
    unsafe {
        let device = open(device_id.as_deref(), true)?;
        let client: IAudioClient = device.Activate(windows::Win32::System::Com::CLSCTX_ALL, None)?;
        let wf = stereo_f32_48k();
        let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200_000, 0, &wf, None)?;
        let event: HANDLE = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;
        let buffer_frames = client.GetBufferSize()?;
        let render: IAudioRenderClient = client.GetService()?;

        // start with a buffer of silence so the first event has room to work
        let first = render.GetBuffer(buffer_frames)?;
        std::ptr::write_bytes(first, 0, buffer_frames as usize * 8);
        render.ReleaseBuffer(buffer_frames, 0)?;
        client.Start()?;

        let mut scratch = vec![0.0f32; 4096 * 2];
        while !stop.load(Ordering::Relaxed) {
            if WaitForSingleObject(event, 200) != WAIT_OBJECT_0 { continue; }
            let padding = client.GetCurrentPadding()?;
            let frames = (buffer_frames - padding) as usize;
            if frames == 0 { continue; }
            let frames = frames.min(scratch.len() / 2);
            let buf = &mut scratch[..frames * 2];
            match &mut role {
                Role::Master { engine, dest } => {
                    let mut done = 0;
                    while done < frames {
                        let step = (frames - done).min(engine.config().max_block);
                        engine.process_block(step);
                        let got = dest.pop_slice(&mut buf[done * 2..(done + step) * 2]);
                        for s in &mut buf[done * 2 + got..(done + step) * 2] { *s = 0.0; }
                        done += step;
                    }
                }
                Role::Follower { reader } => { reader.read(buf); }
            }
            let dst = render.GetBuffer(frames as u32)?;
            std::ptr::copy_nonoverlapping(buf.as_ptr() as *const u8, dst, frames * 8);
            render.ReleaseBuffer(frames as u32, 0)?;
        }
        client.Stop()?;
    }
    Ok(())
}
