//! Runs the native Eddy engine (`eddy-win.exe`, shipped next to the app) as a child process and
//! relays its JSON-line protocol to the UI. The audio never touches the webview: the UI only
//! sends small control lines and reads meters back.
//!
//! JS side: `window.__TAURI__.core.invoke('engine_start' | 'engine_stop' | 'engine_request' | 'engine_devices')`.
//! Events to the UI: `engine-log` (a line the engine wrote to stderr), `engine-exit` (its output closed).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

struct Running {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<String>,
    log: Arc<Mutex<Vec<String>>>,
}

#[derive(Clone, Default)]
pub struct EngineState(Arc<Mutex<Option<Running>>>);

/// `EDDY_WIN` overrides the path (handy in development), otherwise it sits next to the app.
fn engine_exe() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("EDDY_WIN") {
        return Ok(PathBuf::from(p));
    }
    let dir = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or("could not find the app folder")?;
    for name in ["eddy-win.exe", "eddy-win"] {
        let p = dir.join(name);
        if p.exists() {
            return Ok(p);
        }
    }
    Err(format!("The audio engine (eddy-win) was not found in {}", dir.display()))
}

fn command(exe: &PathBuf) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes up
    }
    c
}

fn last_log(log: &Arc<Mutex<Vec<String>>>, fallback: &str) -> String {
    match log.lock() {
        Ok(l) => l.iter().rev().find(|s| !s.trim().is_empty()).cloned().unwrap_or_else(|| fallback.to_string()),
        Err(_) => fallback.to_string(),
    }
}

/// One request, one reply line. The engine answers every line in order, so the lock is held
/// for the round trip and stale lines (from an earlier timeout) are thrown away first.
fn roundtrip(r: &mut Running, line: &str, wait: Duration) -> Result<String, String> {
    while r.replies.try_recv().is_ok() {}
    let line = line.replace(['\n', '\r'], " ");
    writeln!(r.stdin, "{}", line.trim())
        .and_then(|_| r.stdin.flush())
        .map_err(|_| last_log(&r.log, "The audio engine is not running."))?;
    match r.replies.recv_timeout(wait) {
        Ok(s) => Ok(s),
        Err(RecvTimeoutError::Timeout) => Err("The audio engine did not answer.".into()),
        Err(RecvTimeoutError::Disconnected) => Err(last_log(&r.log, "The audio engine stopped.")),
    }
}

fn stop_inner(state: &EngineState) {
    let taken = state.0.lock().ok().and_then(|mut g| g.take());
    if let Some(Running { mut child, stdin, .. }) = taken {
        drop(stdin); // end of input is the engine's signal to shut down cleanly
        let t = Instant::now();
        while t.elapsed() < Duration::from_millis(1500) {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Called when the app quits from the tray, so no engine is left holding the sound devices.
pub fn stop_blocking(app: &AppHandle) {
    if let Some(s) = app.try_state::<EngineState>() {
        stop_inner(&s);
    }
}

fn start_inner(app: &AppHandle, state: &EngineState, args: Vec<String>) -> Result<(), String> {
    stop_inner(state);
    let exe = engine_exe()?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut child = command(&exe)
        .arg("run")
        .args(args)
        .current_dir(dir) // profiles and backups are written here
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the audio engine: {e}"))?;
    let stdin = child.stdin.take().ok_or("no engine input")?;
    let stdout = child.stdout.take().ok_or("no engine output")?;
    let stderr = child.stderr.take().ok_or("no engine log")?;

    let (tx, rx) = channel();
    {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    return;
                }
            }
            let _ = app.emit("engine-exit", ());
        });
    }
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let (app, log) = (app.clone(), log.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app.emit("engine-log", line.clone());
                if let Ok(mut l) = log.lock() {
                    l.push(line);
                    if l.len() > 20 {
                        l.remove(0);
                    }
                }
            }
        });
    }

    let mut running = Running { child, stdin, replies: rx, log };
    // A device name the engine cannot find makes it exit straight away, which shows up here as a
    // failed ping with its message. A device that is found but fails to open later is not caught yet.
    match roundtrip(&mut running, r#"{"cmd":"ping"}"#, Duration::from_secs(6)) {
        Ok(_) => {
            *state.0.lock().map_err(|_| "engine lock poisoned")? = Some(running);
            Ok(())
        }
        Err(e) => {
            let _ = running.child.kill();
            let _ = running.child.wait();
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn engine_start(
    app: AppHandle,
    state: State<'_, EngineState>,
    mic: Option<String>,
    out: Option<String>,
    virtual_mic: Option<String>,
    system: Option<String>,
) -> Result<(), String> {
    let mut args = Vec::new();
    for (flag, v) in [("--mic", mic), ("--out", out), ("--virtual-mic", virtual_mic), ("--system", system)] {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            args.push(flag.to_string());
            args.push(v);
        }
    }
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_inner(&app, &s, args))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn engine_stop(state: State<'_, EngineState>) -> Result<(), String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_inner(&s))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn engine_request(state: State<'_, EngineState>, line: String) -> Result<String, String> {
    let s = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut g = s.0.lock().map_err(|_| "engine lock poisoned".to_string())?;
        let reply = match g.as_mut() {
            Some(r) => roundtrip(r, &line, Duration::from_secs(2)),
            None => Err("The audio engine is not running.".to_string()),
        };
        reply
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn engine_devices() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = engine_exe()?;
        let o = command(&exe)
            .args(["list", "--json"])
            .output()
            .map_err(|e| format!("Could not list audio devices: {e}"))?;
        if o.status.success() {
            Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&o.stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
