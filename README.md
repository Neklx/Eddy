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
| `windows/eddy-win` WASAPI capture, loopback, render, device list | written, **never compiled or run** |
| Per-app capture (WASAPI process loopback) | not started |
| Virtual devices (own driver) | not started, MVP uses VB-Cable |
| Tauri UI | not started |

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
