param(
  [switch]$NoBrowser,
  [int]$Port = 8085,
  [string]$DataDirectory = '.local/seminar-demo-expanded-v11-20261020'
)
$ErrorActionPreference = 'Stop'
$repoDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataPath = [IO.Path]::GetFullPath((Join-Path $repoDirectory $DataDirectory))
if (-not $dataPath.StartsWith($repoDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The demonstration data must be inside this project.'
}
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid demonstration port.' }
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$stateDirectory = Join-Path $repoDirectory '.local/launcher'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$stateFile = Join-Path $stateDirectory ("server-$Port.json")
$baseUrl = "http://127.0.0.1:$Port"
$running = $null
try { $running = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 2 } catch {}
if ($running) {
  if (-not (Test-Path -LiteralPath $stateFile)) { throw "Port $Port is already in use. Stop the previous demonstration service before using this launcher." }
  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
  $ownsPort = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $state.pid }
  if (-not $process -or -not $ownsPort -or $process.StartTime.ToUniversalTime().ToString('o') -ne ([DateTime]$state.processStart).ToUniversalTime().ToString('o') -or $state.dataPath -ne $dataPath) {
    throw "Port $Port belongs to another service or demonstration dataset."
  }
  Write-Output "Demonstration already running: $baseUrl"
} else {
  $previousDirectory = Get-Location
  $environmentBackup = @{}
  foreach ($key in @('APP_MODE', 'PORT', 'LOCAL_DATA_PATH', 'NODE_ENV')) { $environmentBackup[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
  try {
    Set-Location -LiteralPath $repoDirectory
    $env:APP_MODE = 'local'
    $env:PORT = [string]$Port
    $env:LOCAL_DATA_PATH = $dataPath
    $env:NODE_ENV = ''
    & $nodeCommand --env-file-if-exists=.env --import tsx tools/check-seminar.ts --require-ready
    if ($LASTEXITCODE -ne 0) { throw 'Demonstration preflight failed; no server was started.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $process = Start-Process -FilePath $nodeCommand -ArgumentList @('--env-file-if-exists=.env', 'dist/server/index.mjs') -WorkingDirectory $repoDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stateDirectory "$Port-$stamp.log") -RedirectStandardError (Join-Path $stateDirectory "$Port-$stamp.error.log")
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 250
      $process.Refresh()
      if ($process.HasExited) { throw 'The demonstration service stopped during startup. Check the launcher error log.' }
      try { $null = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 1; $ready = $true; break } catch {}
    }
    if (-not $ready) { throw 'The demonstration did not become ready in time. Check the launcher logs.' }
    @{
      pid = $process.Id; processStart = $process.StartTime.ToUniversalTime().ToString('o')
      repoPath = $repoDirectory; dataPath = $dataPath; baseUrl = $baseUrl
      startedAt = [DateTime]::UtcNow.ToString('o')
      windowsBoot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    Write-Output "Demonstration ready: $baseUrl"
  } finally {
    foreach ($key in $environmentBackup.Keys) { [Environment]::SetEnvironmentVariable($key, $environmentBackup[$key], 'Process') }
    Set-Location -LiteralPath $previousDirectory.Path
  }
}
if (-not $NoBrowser) { Start-Process "$baseUrl/#learning" }
