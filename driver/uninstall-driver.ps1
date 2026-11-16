# Removes the Eddy audio driver and turns test-signing mode off. Run elevated, then reboot.
$ErrorActionPreference = 'Continue'
pnputil /enum-drivers | Select-String -Context 0,6 'Eddy' | Out-String | Write-Host
Write-Host 'Delete the oem*.inf entries shown above with: pnputil /delete-driver oemNN.inf /uninstall /force'
bcdedit /set testsigning off
