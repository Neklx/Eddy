// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Release builds have no console, so a failure at start-up would otherwise be invisible.
/// Everything worth knowing goes to %LOCALAPPDATA%\\Eddy\\eddy-startup.log.
fn log_line(msg: &str) {
    use std::io::Write;
    let Some(base) = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("TEMP")) else { return };
    let dir = std::path::PathBuf::from(base).join("Eddy");
    if std::fs::create_dir_all(&dir).is_err() { return; }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("eddy-startup.log")) {
        let _ = writeln!(f, "{msg}");
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| log_line(&format!("PANIC: {info}"))));
    log_line(&format!("--- Eddy {} starting, args: {:?}", env!("CARGO_PKG_VERSION"), std::env::args().collect::<Vec<_>>()));
    // Ctrl+Alt+M mutes or unmutes the microphone from any app, including a game.
    let mute_key = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM);

    tauri::Builder::default()
        .manage(engine::EngineState::default())
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_stop,
            engine::engine_request,
            engine::engine_devices
        ])
        // A second launch just brings the first window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        // "Start with Windows" starts Eddy hidden in the tray.
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &mute_key && event.state() == ShortcutState::Pressed {
                        let _ = app.emit("toggle-mic", ());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // If another program already owns Ctrl+Alt+M, Eddy still starts, just without the hotkey.
            if let Err(e) = app.global_shortcut().register(mute_key) {
                log_line(&format!("Ctrl+Alt+M could not be registered: {e}"));
            }
            let handle = app.handle().clone();
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

            let open = MenuItem::with_id(app, "open", "Open Eddy", true, None::<&str>)?;
            let mute = MenuItem::with_id(app, "mute", "Mute or unmute microphone (Ctrl+Alt+M)", true, None::<&str>)?;
            let auto = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart_on, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Eddy", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &mute, &auto, &sep, &quit])?;

            let auto_item = auto.clone();
            TrayIconBuilder::with_id("eddy")
                .icon(app.default_window_icon().expect("no app icon").clone())
                .tooltip("Eddy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "mute" => { let _ = app.emit("toggle-mic", ()); }
                    "autostart" => {
                        let al = app.autolaunch();
                        let on = al.is_enabled().unwrap_or(false);
                        let _ = if on { al.disable() } else { al.enable() };
                        let _ = auto_item.set_checked(al.is_enabled().unwrap_or(false));
                    }
                    "quit" => { engine::stop_blocking(app); app.exit(0) }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)
                .map_err(|e| log_line(&format!("tray icon could not be created: {e}")))
                .ok();

            // Started by Windows at sign-in: stay in the tray, do not pop a window.
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = handle.get_webview_window("main") { let _ = w.hide(); }
            }
            Ok(())
        })
        // The window's close button hides it; audio keeps running. Quit from the tray.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Eddy");
    log_line("Eddy exited normally");
}
