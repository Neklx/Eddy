# Eddy

Windows audio mixer and virtual microphone: route your mic, apps and system sound to headphones,
voice chat and stream, with noise removal and a voice chain, and a Repair button that works.

## What exists

| Part | State |
|---|---|
| `eddy-dsp` EQ, gate, compressor, leveler, limiter, FFT, noise suppressor, routing matrix | done, 18 tests |
| `eddy-ring` wait-free ring buffer | done, 3 tests |
| `eddy-json` small JSON | done, 3 tests |
| `eddy-engine` engine, clock-drift correction, profiles, versioned backups, repair, JSON-line control protocol | done, 17 tests |
| `eddy-cli` offline simulation to WAV, live `serve` mode | done |
| `windows/eddy-win` WASAPI capture, loopback, render, device list (`list --json`) | written, **never compiled or run** |
| Per-app capture (WASAPI process loopback) | written behind `--features process-loopback`, **never compiled or run**, not wired to the UI |
| Virtual devices (own driver) | experimental driver in `driver/`, never built. MVP uses VB-Cable |
| Tauri app (tray, hotkey, installer) | written, never built here. UI is `web/` (Web Audio engine) |
| UI -> native engine bridge | written. Opt-in "Native engine (beta)" card on the Devices page. Translator tested here, Rust side **never compiled** |

## Try it (any OS with Rust)

    cargo test
    cargo run --release -p eddy-cli -- simulate out      # writes out/mic_original.wav and out/mic_processed.wav
    echo '{"cmd":"get_state"}' | cargo run --release -p eddy-cli -- serve

## Windows (first real test)

    cd windows/eddy-win
    cargo run -- list
    cargo run -- run --mic "your mic" --out "your headphones" --virtual-mic "CABLE Input"

Install VB-Cable first, then pick "CABLE Output" as the microphone in your voice app.
For system sound: create a second virtual output, set it as the Windows default, and pass it as `--system`.
Never pass the same device as `--out` and `--system`.

## Windows app extras

- Tray icon, close-to-tray, single instance, "Start with Windows" (tray menu), Ctrl+Alt+M mute hotkey.
- `driver/`: experimental test-signed virtual audio driver, built by `.github/workflows/driver.yml`.

## Native engine mode (desktop app)

The app runs the web engine by default. On the Devices page, "Native engine (beta)" starts `eddy-win` as a
separate process (bundled next to the app as a Tauri sidecar), suspends Web Audio, and keeps the engine in
sync with the graph. The engine is a fixed mixer, so `web/src/native.js` translates the graph and lists what it
cannot do (no per-app sources yet, recorder, delay, reverb and pan stay in the web engine, EQ band settings are
not sent). Microphone and system sound are the only native inputs for now. Output nodes named like "Voice chat"
or "Stream" go to the virtual microphone, all others to headphones.

Tests: `node web/test/native.test.js` (translator on the real presets), `node web/test/native-ui.test.js`
(card and bridge against a fake Tauri backend, needs Playwright).
