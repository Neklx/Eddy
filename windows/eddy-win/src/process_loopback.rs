//! Per-app capture: hears only one program (and its child processes), or everything except it.
//! Needs Windows 10 build 20348 or later. UNCOMPILED, behind the `process-loopback` feature
//! until it has been built and run on a real Windows machine.
//!
//! Flow: ActivateAudioInterfaceAsync on VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK with an
//! AUDIOCLIENT_ACTIVATION_PARAMS blob, wait for the completion handler, then use the returned
//! IAudioClient like any other loopback client (event driven, 48 kHz float stereo).
#![cfg(all(windows, feature = "process-loopback"))]

use std::sync::{Arc, Condvar, Mutex};
use windows::core::{implement, Interface, Result, HRESULT};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Media::Audio::*;
use std::mem::ManuallyDrop;
use windows::core::PROPVARIANT;

/// VT_BLOB from wtypes.h. Spelled out so the feature needs no extra `windows` module.
const VT_BLOB: u16 = 65;

type Slot = Arc<(Mutex<Option<Result<IAudioClient>>>, Condvar)>;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Handler(Slot);

impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
    fn ActivateCompleted(&self, op: Option<&IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        let result = (|| {
            let op = op.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
            let mut hr = HRESULT(0);
            let mut unk = None;
            unsafe { op.GetActivateResult(&mut hr, &mut unk)? };
            hr.ok()?;
            unk.ok_or_else(|| windows::core::Error::from(E_FAIL))?.cast::<IAudioClient>()
        })();
        let (m, cv) = &*self.0;
        *m.lock().unwrap() = Some(result);
        cv.notify_all();
        Ok(())
    }
}

/// `include = true` captures only `pid` and its children; `false` captures everything except them.
pub fn activate(pid: u32, include: bool) -> Result<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if include {
                    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                } else {
                    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                },
            },
        },
    };
    // Build a VT_BLOB PROPVARIANT that points at `params` on this stack frame.
    // ManuallyDrop: PROPVARIANT's Drop would call PropVariantClear and try to free the
    // blob, which is not heap memory. `params` outlives the call below because we block
    // until the completion handler has fired.
    let mut raw: windows::core::imp::PROPVARIANT = unsafe { std::mem::zeroed() };
    unsafe {
        let v = &mut raw.Anonymous.Anonymous;
        v.vt = VT_BLOB;
        v.Anonymous.blob.cbSize = std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32;
        v.Anonymous.blob.pBlobData = &mut params as *mut _ as *mut u8;
    }
    let prop = ManuallyDrop::new(unsafe { PROPVARIANT::from_raw(raw) });
    let slot: Slot = Arc::new((Mutex::new(None), Condvar::new()));
    let handler: IActivateAudioInterfaceCompletionHandler = Handler(slot.clone()).into();
    let _op = unsafe {
        ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*prop as *const PROPVARIANT), &handler)?
    };
    let (m, cv) = &*slot;
    let mut g = m.lock().unwrap();
    while g.is_none() { g = cv.wait(g).unwrap(); }
    g.take().unwrap()
}
