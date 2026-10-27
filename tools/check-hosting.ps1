$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$deploymentScript = Join-Path $repository 'infra/deploy-hosting.ps1'
$temporaryParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath
$temporaryDirectory = [IO.Path]::GetFullPath((Join-Path $temporaryParent ('yzt-hosting-check-' + [guid]::NewGuid().ToString('N'))))
$firebaseConfigPath = Join-Path $temporaryDirectory 'firebase-public.json'
$projectId = 'yzt-offline-12345'
$sentinel = 'synthetic-config-value-never-copy-into-hosting'
$previousNpxFunction = Get-Item Function:\npx -ErrorAction SilentlyContinue
$previousMockState = Get-Variable YztOfflineHostingState -Scope Global -ErrorAction SilentlyContinue
$previousMockValue = if ($previousMockState) { $previousMockState.Value } else { $null }
$previousExitCodeVariable = Get-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$hadPreviousExitCode = $null -ne $previousExitCodeVariable
$previousExitCode = if ($hadPreviousExitCode) { [int]$previousExitCodeVariable.Value } else { $null }
$previousPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
$script:passedChecks = 0

function Assert-Hosting([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Offline Hosting check failed: $Message" }
}

function Write-PublicConfig([string]$Project = $projectId, [string]$Domain = "$projectId.firebaseapp.com") {
  [IO.File]::WriteAllText(
    $firebaseConfigPath,
    (@{ projectId = $Project; authDomain = $Domain; apiKey = $sentinel } | ConvertTo-Json),
    [Text.UTF8Encoding]::new($false)
  )
}

# This function is the only CLI available during the suite. No executable or
# network command is called, even for the simulated deployment scenarios.
function global:npx {
  $arguments = @($args | ForEach-Object { [string]$_ })
  $configurationPosition = [array]::IndexOf($arguments, '--config')
  if ($configurationPosition -lt 0) { throw 'Mock requires an explicit config.' }
  $configurationPath = $arguments[$configurationPosition + 1]
  $configurationText = [IO.File]::ReadAllText($configurationPath)
  $configuration = $configurationText | ConvertFrom-Json
  $publicPath = Join-Path (Split-Path -Parent $configurationPath) $configuration.hosting.public
  $global:YztOfflineHostingState.Calls.Add([pscustomobject]@{
    Arguments = $arguments
    ConfigurationPath = $configurationPath
    ConfigurationText = $configurationText
    Configuration = $configuration
    PublicPath = $publicPath
    PublicFiles = @(Get-ChildItem -LiteralPath $publicPath -Force -Recurse)
    WorkingDirectory = (Get-Location).ProviderPath
  })
  if ($global:YztOfflineHostingState.Throw) { throw 'Synthetic CLI failure.' }
  $global:LASTEXITCODE = $global:YztOfflineHostingState.ExitCode
}

function Invoke-HostingScenario {
  param(
    [string]$Name,
    [hashtable]$Parameters = @{},
    [int]$ExitCode = 0,
    [switch]$CliThrows,
    [switch]$NoNpx,
    [switch]$ExpectFailure
  )
  $global:YztOfflineHostingState = @{
    Calls = [Collections.Generic.List[object]]::new()
    ExitCode = $ExitCode
    Throw = [bool]$CliThrows
  }
  $arguments = @{ ProjectId = $projectId; FirebaseConfigPath = $firebaseConfigPath }
  foreach ($entry in $Parameters.GetEnumerator()) { $arguments[$entry.Key] = $entry.Value }
  $workingDirectory = (Get-Location).ProviderPath
  $beforeDirectories = @(Get-ChildItem -LiteralPath $temporaryParent -Directory -Filter 'yzt-hosting-*' | ForEach-Object FullName)
  $mockFunction = (Get-Item Function:\npx).ScriptBlock
  if ($NoNpx) { Remove-Item Function:\npx }
  $output = @()
  $failure = $null
  try {
    if ($NoNpx) {
      Assert-Hosting ($null -eq (Get-Command npx -ErrorAction SilentlyContinue)) "${Name}: npx must actually be unavailable."
    } else {
      Assert-Hosting ((Get-Command npx -ErrorAction Stop).CommandType -eq 'Function') "${Name}: only the local npx mock may run."
    }
    $output = @(& $deploymentScript @arguments *>&1)
  }
  catch { $failure = $_ }
  finally {
    if ($NoNpx) { Set-Item Function:\global:npx -Value $mockFunction }
  }
  $calls = @($global:YztOfflineHostingState.Calls.ToArray())
  Assert-Hosting (((Get-Location).ProviderPath) -ceq $workingDirectory) "${Name}: current directory was not restored."
  $afterDirectories = @(Get-ChildItem -LiteralPath $temporaryParent -Directory -Filter 'yzt-hosting-*' | ForEach-Object FullName)
  Assert-Hosting (@($afterDirectories | Where-Object { $_ -notin $beforeDirectories }).Count -eq 0) "${Name}: temporary files were not cleaned up."
  Assert-Hosting (-not ((($output | Out-String) + [string]$failure).Contains($sentinel))) "${Name}: public config contents leaked into output."
  foreach ($call in $calls) {
    Assert-Hosting (-not (Test-Path -LiteralPath $call.ConfigurationPath)) "${Name}: config was not removed."
    Assert-Hosting (-not $call.ConfigurationText.Contains($sentinel)) "${Name}: unrelated config contents were copied into Hosting."
  }
  if ($ExpectFailure) {
    Assert-Hosting ($null -ne $failure) "${Name}: failure was expected."
  } else {
    Assert-Hosting ($null -eq $failure) "${Name}: unexpected failure: $failure"
  }
  $script:passedChecks++
  Write-Host "PASS $Name"
  return [pscustomobject]@{ Calls = $calls; Output = $output; Failure = $failure }
}

function Assert-Rewrite($Configuration, [string]$Environment = 'test', [string]$Region = 'asia-east1') {
  Assert-Hosting (@($Configuration.PSObject.Properties.Name).Count -eq 1 -and $Configuration.hosting) 'Only Hosting may appear in firebase.json.'
  $hosting = $Configuration.hosting
  Assert-Hosting ($hosting.site -ceq $projectId -and $hosting.public -ceq 'public') 'Site/public directory mismatch.'
  Assert-Hosting (($hosting.ignore -join '|') -ceq '**/*|**/.*|**/.*/**') 'All files and dotfiles must be ignored.'
  Assert-Hosting (@($hosting.rewrites).Count -eq 1) 'Expected exactly one rewrite.'
  $rewrite = $hosting.rewrites[0]
  Assert-Hosting ($rewrite.source -ceq '**' -and $rewrite.run.serviceId -ceq "yzt-$Environment-web" -and $rewrite.run.region -ceq $Region) 'Cloud Run rewrite mismatch.'
  Assert-Hosting (@($rewrite.run.PSObject.Properties.Name | Where-Object { $_ -notin @('serviceId', 'region') }).Count -eq 0) 'Run rewrite must not pin or mutate a service.'
}

function Assert-DeployCall($Result, [string]$Environment = 'test', [string]$Region = 'asia-east1') {
  Assert-Hosting ($Result.Calls.Count -eq 1) 'Deployment must invoke only the pinned Hosting CLI.'
  $call = $Result.Calls[0]
  $expected = @('--yes', 'firebase-tools@15.34.0', 'deploy', '--only', 'hosting', '--project', $projectId, '--config', $call.ConfigurationPath, '--non-interactive')
  Assert-Hosting (($call.Arguments -join '|') -ceq ($expected -join '|')) 'CLI arguments are not the exact scoped Hosting deployment.'
  Assert-Rewrite $call.Configuration $Environment $Region
  Assert-Hosting ($call.PublicFiles.Count -eq 0) 'Public directory must be empty, including hidden files.'
  Assert-Hosting ($call.WorkingDirectory -ceq (Split-Path -Parent $call.ConfigurationPath)) 'CLI must run in the isolated temporary project.'
  Assert-Hosting (-not $call.WorkingDirectory.StartsWith($repository, [StringComparison]::OrdinalIgnoreCase)) 'CLI must not run inside the repository.'
}

try {
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  # Prevent an accidental fall-through to a real CLI for every scenario.
  [Environment]::SetEnvironmentVariable('PATH', '', 'Process')
  Write-PublicConfig
  foreach ($environment in @('test', 'PROD')) {
    $result = Invoke-HostingScenario "ValidateOnly $environment without a CLI" -Parameters @{ ValidateOnly = $true; Environment = $environment } -NoNpx
    Assert-Hosting ($result.Calls.Count -eq 0) 'ValidateOnly reached a CLI.'
    $summary = ($result.Output -join "`n") | ConvertFrom-Json
    Assert-Hosting ($summary.cloudStateChecked -eq $false -and $summary.existingSiteReviewRequired -eq $true) 'Validation must disclose its local scope and existing-site review.'
    Assert-Hosting ($summary.firebaseToolsVersion -ceq '15.34.0' -and $summary.hostingUrl -ceq "https://$projectId.firebaseapp.com") 'Validation summary mismatch.'
    Assert-Rewrite $summary.firebaseConfig $environment.ToLowerInvariant()
  }
  foreach ($domain in @("$projectId.web.app", "$projectId.firebaseapp.com.attacker.invalid", "$projectId.FIREBASEAPP.COM", '')) {
    Write-PublicConfig -Domain $domain
    $result = Invoke-HostingScenario 'Wrong or missing authDomain fails before CLI' -Parameters @{ ValidateOnly = $true } -ExpectFailure
    Assert-Hosting ($result.Calls.Count -eq 0) 'Invalid authDomain reached a CLI.'
  }
  Write-PublicConfig -Project 'another-project'
  $result = Invoke-HostingScenario 'Mismatched Firebase project fails before CLI' -ExpectFailure
  Assert-Hosting ($result.Calls.Count -eq 0) 'Mismatched project reached a CLI.'
  [IO.File]::WriteAllText($firebaseConfigPath, '{invalid-json', [Text.UTF8Encoding]::new($false))
  $result = Invoke-HostingScenario 'Malformed Firebase config fails before CLI' -ExpectFailure
  Assert-Hosting ($result.Calls.Count -eq 0) 'Malformed config reached a CLI.'
  Write-PublicConfig
  foreach ($parameters in @(
    @{ ProjectId = 'invalid-project;injection' },
    @{ Region = 'asia-east1;injection' },
    @{ Environment = 'staging' },
    @{ FirebaseConfigPath = (Join-Path $temporaryDirectory 'missing.json') }
  )) {
    $result = Invoke-HostingScenario 'Invalid deployment input fails before CLI' -Parameters $parameters -ExpectFailure
    Assert-Hosting ($result.Calls.Count -eq 0) 'Invalid input reached a CLI.'
  }
  $result = Invoke-HostingScenario 'Actual mode without a CLI fails without files' -NoNpx -ExpectFailure
  Assert-Hosting ($result.Calls.Count -eq 0) 'Missing CLI unexpectedly ran.'
  $result = Invoke-HostingScenario 'Isolated test Hosting deployment uses pinned CLI'
  Assert-DeployCall $result
  $result = Invoke-HostingScenario 'Prod and region map only to the requested web service' -Parameters @{ Environment = 'PROD'; Region = 'us-central1' }
  Assert-DeployCall $result 'prod' 'us-central1'
  $result = Invoke-HostingScenario 'CLI exit failure cleans all temporary files' -ExitCode 17 -ExpectFailure
  Assert-DeployCall $result
  Assert-Hosting ([string]$result.Failure -like '*exit code 17*') 'CLI failure did not propagate its exit code.'
  $result = Invoke-HostingScenario 'Terminating CLI failure restores location and cleans files' -CliThrows -ExpectFailure
  Assert-DeployCall $result
  Write-Host "Offline Hosting checks passed: $script:passedChecks scenarios; every CLI call was a local mock; no network or deployment executed."
} finally {
  [Environment]::SetEnvironmentVariable('PATH', $previousPath, 'Process')
  if ($previousNpxFunction) { Set-Item Function:\global:npx -Value $previousNpxFunction.ScriptBlock }
  else { Remove-Item Function:\npx -ErrorAction SilentlyContinue }
  if ($previousMockState) { Set-Variable YztOfflineHostingState -Scope Global -Value $previousMockValue }
  else { Remove-Variable YztOfflineHostingState -Scope Global -ErrorAction SilentlyContinue }
  if ($hadPreviousExitCode) { $global:LASTEXITCODE = $previousExitCode }
  else { Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $temporaryDirectory) {
    $resolvedDirectory = (Resolve-Path -LiteralPath $temporaryDirectory).ProviderPath
    $temporaryPrefix = $temporaryParent.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $directoryItem = Get-Item -LiteralPath $resolvedDirectory -Force
    if (
      -not $resolvedDirectory.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not $resolvedDirectory.Equals($temporaryDirectory, [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $resolvedDirectory) -cnotmatch '^yzt-hosting-check-[a-f0-9]{32}$' -or
      ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
    ) { throw 'Refusing to remove an unverified Hosting test temporary directory.' }
    Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force
  }
}
