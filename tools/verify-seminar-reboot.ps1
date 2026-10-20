param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$repoDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $repoDirectory
try {
  & (Join-Path $PSScriptRoot 'start-seminar.ps1') -NoBrowser
  & node --import tsx tools/check-seminar-boot.ts verify
  if ($LASTEXITCODE -ne 0) { throw 'Reboot verification is incomplete. See .local/reports/seminar-windows-reboot.json.' }
  & node --import tsx tools/check-seminar-postboot.ts
  if ($LASTEXITCODE -ne 0) { throw 'Saved-results UI verification failed. See .local/reports/seminar-postboot-ui.json.' }
  if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8085/#learning' }
} finally {
  Pop-Location
}
