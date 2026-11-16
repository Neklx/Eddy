# Renames the SysVAD sample's devices to Eddy's. BEST EFFORT and unverified: the exact strings
# in the sample can differ between versions, so this lists every match it changes.
param([Parameter(Mandatory)][string]$SysvadDir)
$map = [ordered]@{
  'Virtual Audio Driver (Simple Audio Sample)' = 'Eddy Virtual Audio'
  'Virtual Speaker'                            = 'Eddy Stream'
  'Virtual Microphone'                         = 'Eddy Mic'
  'Contoso'                                    = 'Eddy'
}
Get-ChildItem -Path $SysvadDir -Recurse -Include *.inx,*.rc,*.h,*.cpp,*.inf,*.txt -File | ForEach-Object {
  $t = Get-Content -Raw -LiteralPath $_.FullName; $o = $t
  foreach ($k in $map.Keys) { $t = $t.Replace($k, $map[$k]) }
  if ($t -ne $o) { Set-Content -LiteralPath $_.FullName -Value $t -NoNewline; Write-Host "patched $($_.FullName)" }
}
