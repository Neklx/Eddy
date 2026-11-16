# Eddy virtual audio driver (experimental, test-signed)

A renamed fork of Microsoft's SysVAD sample (virtual audio driver), built and test-signed by
`.github/workflows/driver.yml`. It gives you "Eddy Mic" and "Eddy Stream" devices on your own PC.

Test-signed means: it only loads in Windows test-signing mode (Secure Boot off, "Test Mode"
watermark), so it is for developers and friends who accept that. A public release needs an EV
certificate and a Microsoft submission (see the project plan).

Use: run the workflow, download the `eddy-driver` artifact, unzip, run `install-driver.ps1`
in an elevated PowerShell, restart. `uninstall-driver.ps1` reverses it.

Status: never built. The workflow downloads the sample at build time, so the first run will show
which parts (WDK install, project path, string names) need adjusting.
