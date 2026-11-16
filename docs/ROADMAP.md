# Eddy build order

Each step ends with something you can run and check.

1. **eddy-dsp** (done): gain ramps, EQ, gate, compressor, leveler, limiter, FFT, spectral noise suppressor, meters, routing matrix. 18 tests.
2. **eddy-engine** (core done and tested; WASAPI glue written in windows/eddy-win but not yet compiled or run): the audio process. Adds WASAPI capture and render (`wasapi` crate), a lock-free
   ring buffer between devices (`rtrb`), clock drift handling, and the control channel (named pipe).
   Milestone: mic through the chain to headphones with a measured latency number.
3. **Virtual devices (MVP)**: use VB-Cable as the "Eddy Mic" endpoint to ship without owning a
   kernel driver. Milestone: a voice app hears the processed mic.
4. **Per-app capture**: WASAPI process loopback (Windows 10 build 20348+ / Windows 11).
   Milestone: Music player routed to voice chat while the voice app is excluded (echo protection).
5. **Noise removal**: RNNoise first (BSD, tiny), then DeepFilterNet3 behind the same trait.
6. **UI shell**: Tauri 2 + the screens in the design canvas, with Lucide icons. UI talks to the engine
   over the pipe; the audio never runs in the webview.
7. **Repair, backups, first run**: the Health and First run screens, wired to real checks.
8. **Own driver**: SYSVAD-derived or Thesycon SDK, EV cert and attestation signing. Long lead time
   (certificate and Microsoft Partner Center), so start the paperwork during step 3.

Needs a Windows machine from step 2 on. This cloud session can only build and test platform-independent code.
