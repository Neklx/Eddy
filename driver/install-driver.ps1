# Installs the test-signed Eddy audio driver on THIS PC. Run in an elevated PowerShell.
# It turns on Windows test-signing mode, which needs Secure Boot off and shows a "Test Mode"
# watermark. Reboot afterwards. Do not use on a PC that must run kernel anti-cheat.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
Import-Certificate -FilePath (Join-Path $dir 'eddy-test.cer') -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath (Join-Path $dir 'eddy-test.cer') -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
bcdedit /set testsigning on
pnputil /add-driver (Join-Path $dir '*.inf') /install
Write-Host 'Done. Restart Windows, then look for "Eddy Mic" and "Eddy Stream" in Sound settings.'
