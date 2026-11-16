use windows::core::PWSTR;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;

#[derive(Clone, Debug)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_render: bool,
    pub is_default: bool,
}

pub fn com_init() -> windows::core::Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
}

pub fn enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn pwstr_to_string(p: PWSTR) -> String {
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

pub fn device_id(d: &IMMDevice) -> windows::core::Result<String> {
    unsafe { Ok(pwstr_to_string(d.GetId()?)) }
}

pub fn device_name(d: &IMMDevice) -> windows::core::Result<String> {
    unsafe {
        let store = d.OpenPropertyStore(STGM_READ)?;
        let var = store.GetValue(&PKEY_Device_FriendlyName)?;
        Ok(pwstr_to_string(PropVariantToStringAlloc(&var)?))
    }
}

/// Active render and capture endpoints, defaults flagged.
pub fn list() -> windows::core::Result<Vec<DeviceInfo>> {
    let en = enumerator()?;
    let mut out = Vec::new();
    for (flow, is_render) in [(eRender, true), (eCapture, false)] {
        unsafe {
            let default_id = en.GetDefaultAudioEndpoint(flow, eConsole).ok().and_then(|d| device_id(&d).ok());
            let coll = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?;
            for i in 0..coll.GetCount()? {
                let d = coll.Item(i)?;
                let id = device_id(&d)?;
                out.push(DeviceInfo { name: device_name(&d).unwrap_or_else(|_| "Unknown device".into()), is_default: default_id.as_deref() == Some(id.as_str()), id, is_render });
            }
        }
    }
    Ok(out)
}

/// Finds a device by id, or by a case-insensitive part of its name ("cable input").
pub fn find(devices: &[DeviceInfo], is_render: bool, query: &str) -> Option<DeviceInfo> {
    let q = query.to_lowercase();
    devices.iter().find(|d| d.is_render == is_render && (d.id == query || d.name.to_lowercase().contains(&q))).cloned()
}

pub fn open(id: Option<&str>, is_render: bool) -> windows::core::Result<IMMDevice> {
    let en = enumerator()?;
    unsafe {
        match id {
            Some(id) => en.GetDevice(&windows::core::HSTRING::from(id)),
            None => en.GetDefaultAudioEndpoint(if is_render { eRender } else { eCapture }, eConsole),
        }
    }
}
