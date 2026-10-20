$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$deploymentScript = Join-Path $repository 'infra/deploy.ps1'
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('yzt-deploy-check-' + [guid]::NewGuid().ToString('N'))
$firebaseConfigPath = Join-Path $temporaryDirectory 'firebase-public.json'
$projectId = 'yzt-offline-12345'
$openaiSentinel = 'synthetic-openai-secret-offline-check-only'
$nvidiaSentinel = 'synthetic-nvidia-secret-offline-check-only'
$requiredIndexes = @((Get-Content -Raw -LiteralPath (Join-Path $repository 'firestore.indexes.json') | ConvertFrom-Json).indexes)
$readyIndexes = @(for ($indexNumber = 0; $indexNumber -lt $requiredIndexes.Count; $indexNumber++) {
  $index = $requiredIndexes[$indexNumber]
  [ordered]@{
    name = "projects/$projectId/databases/(default)/collectionGroups/$($index.collectionGroup)/indexes/synthetic-$indexNumber"
    queryScope = $index.queryScope
    fields = @($index.fields) + @([ordered]@{ fieldPath = '__name__'; order = $index.fields[-1].order })
    state = 'READY'
  }
})
$readyIndexJson = ConvertTo-Json -InputObject $readyIndexes -Depth 10
$environmentNames = @(
  'AI_PROVIDER', 'AI_TEXT_MODEL', 'AI_VISION_MODEL',
  'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_VISION_MODEL', 'OPENAI_BASE_URL',
  'NVIDIA_API_KEY', 'NVIDIA_TEXT_MODEL', 'NVIDIA_VISION_MODEL', 'NVIDIA_BASE_URL',
  'NVIDIA_TEXT_FALLBACK_MODELS', 'NVIDIA_VISION_FALLBACK_MODELS'
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$previousGcloudFunction = Get-Item Function:\gcloud -ErrorAction SilentlyContinue
$previousMockState = Get-Variable YztOfflineDeploymentState -Scope Global -ErrorAction SilentlyContinue
$previousExitCodeVariable = Get-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
$hadPreviousExitCode = $null -ne $previousExitCodeVariable
# Copy the numeric value: retaining the PSVariable would retain the mock's later mutation.
$previousExitCode = if ($hadPreviousExitCode) { [int]$previousExitCodeVariable.Value } else { $null }
$script:passedChecks = 0

function Assert-Deployment([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Offline deployment check failed: $Message" }
}

function Read-DeploymentYaml([string]$Text) {
  $values = @{}
  foreach ($line in ($Text -split '\r?\n')) {
    if ($line -match '^([A-Z][A-Z0-9_]*):\s*(.*)$') {
      $values[$Matches[1]] = $Matches[2] | ConvertFrom-Json
    } elseif ($line.Trim()) {
      throw 'The generated deployment environment must contain JSON-quoted scalar YAML values.'
    }
  }
  return $values
}

# This function shadows the CLI for the entire test process. Never call an executable.
function global:gcloud {
  $arguments = @($args | ForEach-Object { [string]$_ })
  $standardInput = @($input | ForEach-Object { [string]$_ })
  $environmentPath = $null
  $environmentText = $null
  $environmentValues = $null
  foreach ($argument in $arguments) {
    if ($argument.StartsWith('--env-vars-file=')) {
      $environmentPath = $argument.Substring('--env-vars-file='.Length)
      $environmentText = [IO.File]::ReadAllText($environmentPath)
      $environmentValues = Read-DeploymentYaml $environmentText
    }
  }
  $call = [pscustomobject]@{
    Arguments = $arguments
    StandardInput = $standardInput
    EnvironmentPath = $environmentPath
    EnvironmentText = $environmentText
    EnvironmentValues = $environmentValues
  }
  $global:YztOfflineDeploymentState.Calls.Add($call)
  $global:LASTEXITCODE = 0
  $joined = $arguments -join ' '
  if ($global:YztOfflineDeploymentState.FailPrefix -and $joined.StartsWith($global:YztOfflineDeploymentState.FailPrefix)) {
    $global:LASTEXITCODE = 17
    return
  }
  if ($joined.StartsWith('run services describe ')) {
    if ($arguments[3] -like '*-worker') { return 'https://synthetic-worker.example.invalid' }
    return 'https://synthetic-web.example.invalid'
  }
  if ($joined.StartsWith('firestore indexes composite list ')) {
    return $global:YztOfflineDeploymentState.IndexJson
  }
  # Empty list responses exercise resource creation without contacting Google Cloud.
}

function Invoke-DeploymentScenario {
  param(
    [string]$Name,
    [hashtable]$Environment = @{},
    [hashtable]$Parameters = @{},
    [string]$FailPrefix = '',
    [string]$IndexJson = $readyIndexJson,
    [switch]$NoGcloudCommand,
    [switch]$ExpectFailure
  )
  foreach ($variable in $environmentNames) {
    [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
  }
  foreach ($entry in $Environment.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
  }
  $global:YztOfflineDeploymentState = @{
    Calls = [Collections.Generic.List[object]]::new()
    FailPrefix = $FailPrefix
    IndexJson = $IndexJson
  }
  $arguments = @{
    ProjectId = $projectId
    FirebaseConfigPath = $firebaseConfigPath
    VapidKey = 'synthetic-public-vapid-key'
  }
  foreach ($entry in $Parameters.GetEnumerator()) { $arguments[$entry.Key] = $entry.Value }
  $beforeTemporaryFiles = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'yzt-env-*.yaml' -File | ForEach-Object FullName)
  $output = @()
  $failure = $null
  $originalPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
  $mockFunction = (Get-Item Function:\gcloud).ScriptBlock
  if ($NoGcloudCommand) {
    Remove-Item Function:\global:gcloud
    [Environment]::SetEnvironmentVariable('PATH', '', 'Process')
  }
  try { $output = @(& $deploymentScript @arguments *>&1) }
  catch { $failure = $_ }
  finally {
    if ($NoGcloudCommand) {
      [Environment]::SetEnvironmentVariable('PATH', $originalPath, 'Process')
      Set-Item Function:\global:gcloud -Value $mockFunction
    }
  }
  $calls = @($global:YztOfflineDeploymentState.Calls.ToArray())
  $combinedOutput = ($output | Out-String) + [string]$failure
  foreach ($secret in @($openaiSentinel, $nvidiaSentinel)) {
    Assert-Deployment (-not $combinedOutput.Contains($secret)) "${Name}: a secret appeared in output or an error."
    foreach ($call in $calls) {
      Assert-Deployment (-not (($call.Arguments -join ' ').Contains($secret))) "${Name}: a secret appeared in CLI arguments."
      Assert-Deployment (-not ([string]$call.EnvironmentText).Contains($secret)) "${Name}: a secret appeared in temporary YAML."
    }
  }
  foreach ($call in $calls | Where-Object EnvironmentPath) {
    Assert-Deployment (-not (Test-Path -LiteralPath $call.EnvironmentPath)) "${Name}: temporary YAML was not removed."
  }
  $afterTemporaryFiles = @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'yzt-env-*.yaml' -File | ForEach-Object FullName)
  Assert-Deployment (@($afterTemporaryFiles | Where-Object { $_ -notin $beforeTemporaryFiles }).Count -eq 0) "${Name}: an unremoved deployment environment file was created."
  if ($ExpectFailure) {
    Assert-Deployment ($null -ne $failure) "${Name}: failure was expected."
  } else {
    Assert-Deployment ($null -eq $failure) "${Name}: the mocked deployment unexpectedly failed."
  }
  return [pscustomobject]@{ Name = $Name; Calls = $calls; Output = $output; Failure = $failure }
}

function Assert-Validation {
  param($Result, [string]$Provider, [string]$TextModel, [string]$VisionModel, [string]$Environment = 'test', [bool]$ExpectedKeyConfigured = $false)
  Assert-Deployment ($Result.Calls.Count -eq 0) "$($Result.Name): ValidateOnly called gcloud."
  $configuration = ($Result.Output | Out-String) | ConvertFrom-Json
  Assert-Deployment ($configuration.validationPassed -eq $true) "$($Result.Name): validation status is missing."
  Assert-Deployment ($configuration.cloudCommandsExecuted -eq 0) "$($Result.Name): validation reported cloud execution."
  Assert-Deployment ($configuration.aiProvider -ceq $Provider) "$($Result.Name): provider selection or normalization changed."
  Assert-Deployment ($configuration.textModel -eq $TextModel) "$($Result.Name): text model precedence changed."
  Assert-Deployment ($configuration.visionModel -eq $VisionModel) "$($Result.Name): vision model precedence changed."
  Assert-Deployment ($configuration.secretName -ceq "yzt-$Environment-$Provider-key") "$($Result.Name): wrong provider secret name or case."
  $expectedKey = if ($Provider -eq 'openai') { 'OPENAI_API_KEY' } else { 'NVIDIA_API_KEY' }
  Assert-Deployment ($configuration.keyEnvironmentVariable -eq $expectedKey) "$($Result.Name): wrong selected key variable."
  Assert-Deployment ($configuration.keyConfigured -eq $ExpectedKeyConfigured) "$($Result.Name): key presence status is incorrect."
  $script:passedChecks++
  Write-Host "PASS $($Result.Name)"
}

function Assert-CloudRunCalls {
  param($Result, [string]$Provider, [string]$TextModel, [string]$VisionModel, [string]$Environment = 'test', [switch]$Partial)
  $keyName = if ($Provider -eq 'openai') { 'OPENAI_API_KEY' } else { 'NVIDIA_API_KEY' }
  $otherKey = if ($Provider -eq 'openai') { 'NVIDIA_API_KEY' } else { 'OPENAI_API_KEY' }
  $secretValue = if ($Provider -eq 'openai') { $openaiSentinel } else { $nvidiaSentinel }
  $runCalls = @($Result.Calls | Where-Object EnvironmentPath)
  $indexCalls = @($Result.Calls | Where-Object { ($_.Arguments[0..3] -join ' ') -eq 'firestore indexes composite list' })
  Assert-Deployment ($indexCalls.Count -eq 1) "$($Result.Name): readiness must be checked exactly once."
  Assert-Deployment ($indexCalls[0].Arguments -contains '--database=(default)' -and $indexCalls[0].Arguments -contains "--project=$projectId" -and $indexCalls[0].Arguments -contains '--format=json') "$($Result.Name): readiness query must target the selected database/project and full JSON."
  $indexPosition = [array]::IndexOf($Result.Calls, $indexCalls[0])
  $buildCalls = @($Result.Calls | Where-Object { ($_.Arguments[0..1] -join ' ') -eq 'builds submit' })
  Assert-Deployment ($buildCalls.Count -eq 1 -and [array]::IndexOf($Result.Calls, $buildCalls[0]) -gt $indexPosition) "$($Result.Name): application build preceded index readiness."
  if (-not $Partial) {
    Assert-Deployment ($runCalls.Count -eq 4) "$($Result.Name): expected two deploys and two updates."
    Assert-Deployment (($runCalls[0].Arguments[0..2] -join ' ') -ceq "run deploy yzt-$Environment-worker") "$($Result.Name): worker deployment missing or resource case changed."
    Assert-Deployment (($runCalls[1].Arguments[0..2] -join ' ') -ceq "run deploy yzt-$Environment-web") "$($Result.Name): web deployment missing or resource case changed."
    Assert-Deployment (($runCalls[2].Arguments[0..3] -join ' ') -ceq "run services update yzt-$Environment-web") "$($Result.Name): web update missing or resource case changed."
    Assert-Deployment (($runCalls[3].Arguments[0..3] -join ' ') -ceq "run services update yzt-$Environment-worker") "$($Result.Name): worker update missing or resource case changed."
    Assert-Deployment (($runCalls.EnvironmentValues.SERVICE_ROLE -join ',') -eq 'worker,web,web,worker') "$($Result.Name): service roles changed."
  }
  foreach ($call in $runCalls) {
    Assert-Deployment ($call.EnvironmentValues.APP_MODE -eq 'firebase') "$($Result.Name): production mode changed."
    Assert-Deployment ($call.EnvironmentValues.AI_PROVIDER -ceq $Provider) "$($Result.Name): Cloud Run provider mismatch."
    Assert-Deployment ($call.EnvironmentValues.STORAGE_BUCKET -ceq "$projectId-yzt-$Environment-data") "$($Result.Name): bucket name is incorrect or not lowercase."
    Assert-Deployment ($call.EnvironmentValues.TASKS_QUEUE -ceq "yzt-$Environment-ai") "$($Result.Name): queue name is incorrect or not lowercase."
    Assert-Deployment ($call.EnvironmentValues.WORKER_SERVICE_ACCOUNT -ceq "yzt-$Environment-caller@$projectId.iam.gserviceaccount.com") "$($Result.Name): service account name is incorrect or not lowercase."
    Assert-Deployment ($call.EnvironmentValues.AI_TEXT_MODEL -eq $TextModel) "$($Result.Name): Cloud Run text model mismatch."
    Assert-Deployment ($call.EnvironmentValues.AI_VISION_MODEL -eq $VisionModel) "$($Result.Name): Cloud Run vision model mismatch."
    $selectedBase = if ($Provider -eq 'openai') { 'OPENAI_BASE_URL' } else { 'NVIDIA_BASE_URL' }
    $otherBase = if ($Provider -eq 'openai') { 'NVIDIA_BASE_URL' } else { 'OPENAI_BASE_URL' }
    $expectedBase = if ($Provider -eq 'openai') { 'https://api.openai.com/v1' } else { 'https://integrate.api.nvidia.com/v1' }
    Assert-Deployment ($call.EnvironmentValues[$selectedBase] -eq $expectedBase -and -not $call.EnvironmentValues.ContainsKey($otherBase)) "$($Result.Name): provider endpoint mismatch."
    foreach ($setting in @{
      AI_REQUEST_TIMEOUT_MS = '45000'; AI_PRIMARY_TIMEOUT_MS = '22000'; AI_TEXT_PRIMARY_TIMEOUT_MS = '12000'
      AI_JOB_TIMEOUT_MS = '120000'; AI_TEXT_MAX_TOKENS = '2400'; AI_VISION_MAX_TOKENS = '2600'
    }.GetEnumerator()) {
      Assert-Deployment ($call.EnvironmentValues[$setting.Key] -eq $setting.Value) "$($Result.Name): bounded runtime settings changed."
    }
    Assert-Deployment ($call.Arguments -ccontains "--set-secrets=$keyName=yzt-$Environment-$Provider-key`:latest") "$($Result.Name): replace-all selected secret binding missing or resource case changed."
    Assert-Deployment (-not (($call.Arguments -join ' ') -match "(?:--set-secrets|--update-secrets)=[^ ]*$otherKey=")) "$($Result.Name): another provider secret was bound."
    Assert-Deployment (-not $call.EnvironmentValues.ContainsKey('NVIDIA_TEXT_FALLBACK_MODELS')) "$($Result.Name): a fallback route was injected."
    Assert-Deployment (-not $call.EnvironmentValues.ContainsKey('NVIDIA_VISION_FALLBACK_MODELS')) "$($Result.Name): a vision fallback route was injected."
    Assert-Deployment (-not $call.EnvironmentValues.ContainsKey('OPENAI_API_KEY') -and -not $call.EnvironmentValues.ContainsKey('NVIDIA_API_KEY')) "$($Result.Name): key value belongs in Secret Manager, not YAML."
  }
  $uploadCalls = @($Result.Calls | Where-Object { ($_.Arguments[0..2] -join ' ') -eq 'secrets versions add' })
  Assert-Deployment ($uploadCalls.Count -eq 1) "$($Result.Name): expected one selected key upload."
  Assert-Deployment ($uploadCalls[0].Arguments[3] -ceq "yzt-$Environment-$Provider-key") "$($Result.Name): wrong uploaded secret or case."
  Assert-Deployment ($uploadCalls[0].Arguments -contains '--data-file=-') "$($Result.Name): key upload must use stdin."
  Assert-Deployment ($uploadCalls[0].StandardInput.Count -eq 1 -and $uploadCalls[0].StandardInput[0] -eq $secretValue) "$($Result.Name): wrong selected key stdin."
  foreach ($call in $Result.Calls | Where-Object { ($_.Arguments[0..2] -join ' ') -ne 'secrets versions add' }) {
    Assert-Deployment ($call.StandardInput.Count -eq 0) "$($Result.Name): key data reached an unrelated command."
  }
  foreach ($call in $Result.Calls) {
    foreach ($argument in $call.Arguments) {
      foreach ($resource in [regex]::Matches($argument, 'yzt-(?:test|prod)[A-Za-z0-9/@:._-]*', [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        Assert-Deployment ($resource.Value -ceq $resource.Value.ToLowerInvariant()) "$($Result.Name): a generated resource name contains uppercase letters."
      }
    }
  }
  $script:passedChecks++
  Write-Host "PASS $($Result.Name)"
}

function Assert-IndexGateFailure {
  param($Result, [switch]$ExpectRepairInstruction)
  $indexCalls = @($Result.Calls | Where-Object { ($_.Arguments[0..3] -join ' ') -eq 'firestore indexes composite list' })
  Assert-Deployment ($indexCalls.Count -eq 1) "$($Result.Name): readiness was not checked."
  Assert-Deployment (@($Result.Calls | Where-Object { $_.Arguments[0] -in @('builds', 'run', 'scheduler') }).Count -eq 0) "$($Result.Name): deployment continued beyond the index-readiness gate."
  Assert-Deployment (@($Result.Calls | Where-Object EnvironmentPath).Count -eq 0) "$($Result.Name): a deployment environment file was used before index readiness."
  Assert-Deployment (@($Result.Calls | Where-Object { ($_.Arguments[0..2] -join ' ') -eq 'firestore indexes composite' -and $_.Arguments[3] -ne 'list' }).Count -eq 0) "$($Result.Name): the readiness gate modified cloud indexes."
  if ($ExpectRepairInstruction) {
    $message = [string]$Result.Failure
    Assert-Deployment ($message.Contains("npx firebase-tools deploy --only firestore:indexes --project $projectId") -and $message.Contains('READY') -and $message.Contains('rerun')) "$($Result.Name): missing actionable index-repair instructions."
  }
  $script:passedChecks++
  Write-Host "PASS $($Result.Name)"
}

try {
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
  @{ projectId = $projectId; apiKey = 'synthetic-public-firebase-config'; appId = 'synthetic-app-id' } | ConvertTo-Json | Set-Content -LiteralPath $firebaseConfigPath -Encoding utf8

  $result = Invoke-DeploymentScenario 'ValidateOnly default OpenAI without keys or installed gcloud' -Parameters @{ ValidateOnly = $true } -NoGcloudCommand
  Assert-Validation $result 'openai' 'gpt-6-luna' 'gpt-6-luna'
  $result = Invoke-DeploymentScenario 'ValidateOnly NVIDIA without keys' -Parameters @{ ValidateOnly = $true; AiProvider = 'nvidia'; Environment = 'prod' }
  Assert-Validation $result 'nvidia' 'nvidia/nemotron-3.5-super-vl-120b-a12b' 'nvidia/nemotron-3.5-super-vl-120b-a12b' 'prod'
  foreach ($provider in @('OPENAI', 'NVIDIA')) {
    foreach ($deploymentEnvironment in @('TEST', 'PROD')) {
      $result = Invoke-DeploymentScenario "ValidateOnly normalizes $provider and $deploymentEnvironment" -Parameters @{ ValidateOnly = $true; AiProvider = $provider; Environment = $deploymentEnvironment }
      $model = if ($provider -eq 'OPENAI') { 'gpt-6-luna' } else { 'nvidia/nemotron-3.5-super-vl-120b-a12b' }
      Assert-Validation $result $provider.ToLowerInvariant() $model $model $deploymentEnvironment.ToLowerInvariant()
    }
  }
  $result = Invoke-DeploymentScenario 'ValidateOnly reports key presence without revealing either key' -Environment @{ OPENAI_API_KEY = $openaiSentinel; NVIDIA_API_KEY = $nvidiaSentinel; AI_PROVIDER = 'nvidia' } -Parameters @{ ValidateOnly = $true }
  Assert-Validation $result 'openai' 'gpt-6-luna' 'gpt-6-luna' -ExpectedKeyConfigured $true

  $modelEnvironment = @{
    AI_TEXT_MODEL = 'synthetic-generic-text'; AI_VISION_MODEL = 'synthetic-generic-vision'
    OPENAI_TEXT_MODEL = 'synthetic-openai-text'; OPENAI_VISION_MODEL = 'synthetic-openai-vision'
    NVIDIA_TEXT_MODEL = 'synthetic/nvidia-text'; NVIDIA_VISION_MODEL = 'synthetic/nvidia-vision'
  }
  $result = Invoke-DeploymentScenario 'Explicit models override both environment levels' -Environment $modelEnvironment -Parameters @{ ValidateOnly = $true; TextModel = 'synthetic-explicit-text'; VisionModel = 'synthetic-explicit-vision' }
  Assert-Validation $result 'openai' 'synthetic-explicit-text' 'synthetic-explicit-vision'
  foreach ($provider in @('openai', 'nvidia')) {
    $result = Invoke-DeploymentScenario "Generic environment models precede $provider models" -Environment $modelEnvironment -Parameters @{ ValidateOnly = $true; AiProvider = $provider }
    Assert-Validation $result $provider 'synthetic-generic-text' 'synthetic-generic-vision'
  }
  $modelEnvironment.Remove('AI_TEXT_MODEL')
  $modelEnvironment.Remove('AI_VISION_MODEL')
  foreach ($provider in @('openai', 'nvidia')) {
    $result = Invoke-DeploymentScenario "Only $provider-specific model environment is selected" -Environment $modelEnvironment -Parameters @{ ValidateOnly = $true; AiProvider = $provider }
    $text = if ($provider -eq 'openai') { 'synthetic-openai-text' } else { 'synthetic/nvidia-text' }
    $vision = if ($provider -eq 'openai') { 'synthetic-openai-vision' } else { 'synthetic/nvidia-vision' }
    Assert-Validation $result $provider $text $vision
  }

  foreach ($provider in @('openai', 'nvidia')) {
    $otherKey = if ($provider -eq 'openai') { 'NVIDIA_API_KEY' } else { 'OPENAI_API_KEY' }
    $otherValue = if ($provider -eq 'openai') { $nvidiaSentinel } else { $openaiSentinel }
    $result = Invoke-DeploymentScenario "Missing selected $provider key fails before gcloud" -Environment @{ $otherKey = $otherValue } -Parameters @{ AiProvider = $provider } -ExpectFailure
    Assert-Deployment ($result.Calls.Count -eq 0) "$($result.Name): a cloud command preceded key validation."
    $script:passedChecks++
    Write-Host "PASS $($result.Name)"
  }
  $result = Invoke-DeploymentScenario 'Whitespace-only selected key fails before gcloud' -Environment @{ OPENAI_API_KEY = " `t "; NVIDIA_API_KEY = $nvidiaSentinel } -ExpectFailure
  Assert-Deployment ($result.Calls.Count -eq 0) "$($result.Name): a cloud command preceded key validation."
  $script:passedChecks++
  Write-Host "PASS $($result.Name)"

  foreach ($invalidModel in @('has whitespace', "control`nmodel", ('x' * 300), 'sk-synthetic-not-a-model', 'nvapi-synthetic-not-a-model')) {
    $result = Invoke-DeploymentScenario 'Malformed model is rejected before cloud access without echoing input' -Parameters @{ ValidateOnly = $true; TextModel = $invalidModel } -ExpectFailure
    Assert-Deployment ($result.Calls.Count -eq 0) "$($result.Name): an invalid model reached gcloud."
    Assert-Deployment (-not (($result.Output | Out-String) + [string]$result.Failure).Contains($invalidModel)) "$($result.Name): invalid model input was echoed."
    $script:passedChecks++
    Write-Host "PASS $($result.Name)"
  }

  $bothKeys = @{ OPENAI_API_KEY = $openaiSentinel; NVIDIA_API_KEY = $nvidiaSentinel }
  Assert-Deployment ($requiredIndexes.Count -eq 4) 'Expected four due-query indexes in the repository manifest.'
  $result = Invoke-DeploymentScenario 'No cloud indexes stops before build, Cloud Run and Scheduler' -Environment $bothKeys -IndexJson '[]' -ExpectFailure
  Assert-IndexGateFailure $result -ExpectRepairInstruction
  $partialIndexes = @($readyIndexes | Select-Object -Skip 1)
  $result = Invoke-DeploymentScenario 'One missing required index blocks deployment' -Environment $bothKeys -IndexJson (ConvertTo-Json -InputObject $partialIndexes -Depth 10) -ExpectFailure
  Assert-IndexGateFailure $result -ExpectRepairInstruction
  foreach ($indexState in @('CREATING', 'NEEDS_REPAIR')) {
    $changedIndexes = $readyIndexJson | ConvertFrom-Json
    $changedIndexes[0].state = $indexState
    $result = Invoke-DeploymentScenario "An index in $indexState state blocks deployment" -Environment $bothKeys -IndexJson (ConvertTo-Json -InputObject $changedIndexes -Depth 10) -ExpectFailure
    Assert-IndexGateFailure $result -ExpectRepairInstruction
  }
  foreach ($change in @('field order', 'field direction', 'query scope', 'collection group')) {
    $changedIndexes = $readyIndexJson | ConvertFrom-Json
    switch ($change) {
      'field order' { $fields = $changedIndexes[0].fields; $changedIndexes[0].fields = @($fields[1], $fields[0], $fields[2]) }
      'field direction' { $changedIndexes[0].fields[1].order = 'DESCENDING'; $changedIndexes[0].fields[2].order = 'DESCENDING' }
      'query scope' { $changedIndexes[0].queryScope = 'COLLECTION_GROUP' }
      'collection group' { $changedIndexes[0].name = "projects/$projectId/databases/(default)/collectionGroups/unrelated/indexes/synthetic-0" }
    }
    $result = Invoke-DeploymentScenario "A READY index with wrong $change does not satisfy the gate" -Environment $bothKeys -IndexJson (ConvertTo-Json -InputObject $changedIndexes -Depth 10) -ExpectFailure
    Assert-IndexGateFailure $result -ExpectRepairInstruction
  }
  $result = Invoke-DeploymentScenario 'Index listing CLI failure stops before application changes' -Environment $bothKeys -FailPrefix 'firestore indexes composite list ' -ExpectFailure
  Assert-IndexGateFailure $result
  $result = Invoke-DeploymentScenario 'Malformed index-list JSON stops before application changes' -Environment $bothKeys -IndexJson '{invalid-synthetic-json' -ExpectFailure
  Assert-IndexGateFailure $result
  $reversedIndexes = @($readyIndexes)
  [array]::Reverse($reversedIndexes)
  $result = Invoke-DeploymentScenario 'READY index list order and automatic document-name suffix are ignored' -Environment $bothKeys -IndexJson (ConvertTo-Json -InputObject $reversedIndexes -Depth 10)
  Assert-CloudRunCalls $result 'openai' 'gpt-6-luna' 'gpt-6-luna'

  $result = Invoke-DeploymentScenario 'OpenAI default full mocked deployment' -Environment $bothKeys
  Assert-CloudRunCalls $result 'openai' 'gpt-6-luna' 'gpt-6-luna'
  $result = Invoke-DeploymentScenario 'NVIDIA default full mocked deployment' -Environment $bothKeys -Parameters @{ AiProvider = 'nvidia' }
  Assert-CloudRunCalls $result 'nvidia' 'nvidia/nemotron-3.5-super-vl-120b-a12b' 'nvidia/nemotron-3.5-super-vl-120b-a12b'
  foreach ($provider in @('OPENAI', 'NVIDIA')) {
    $result = Invoke-DeploymentScenario "Uppercase $provider PROD deployment uses lowercase resource names" -Environment $bothKeys -Parameters @{ AiProvider = $provider; Environment = 'PROD' }
    $model = if ($provider -eq 'OPENAI') { 'gpt-6-luna' } else { 'nvidia/nemotron-3.5-super-vl-120b-a12b' }
    Assert-CloudRunCalls $result $provider.ToLowerInvariant() $model $model 'prod'
  }
  $overrideEnvironment = $bothKeys.Clone()
  $overrideEnvironment.AI_TEXT_MODEL = 'synthetic-lower-priority-text'
  $overrideEnvironment.AI_VISION_MODEL = 'synthetic-lower-priority-vision'
  $overrideEnvironment.NVIDIA_TEXT_FALLBACK_MODELS = 'synthetic/unused-text-fallback'
  $overrideEnvironment.NVIDIA_VISION_FALLBACK_MODELS = 'synthetic/unused-vision-fallback'
  $result = Invoke-DeploymentScenario 'Explicit OpenAI production models remain identical across all services' -Environment $overrideEnvironment -Parameters @{ TextModel = 'synthetic-chosen-text'; VisionModel = 'synthetic-chosen-vision'; Environment = 'prod' }
  Assert-CloudRunCalls $result 'openai' 'synthetic-chosen-text' 'synthetic-chosen-vision' 'prod'

  foreach ($prefix in @('run deploy ', 'run services update ')) {
    $result = Invoke-DeploymentScenario "Failure at $prefix removes temporary YAML" -Environment $bothKeys -FailPrefix $prefix -ExpectFailure
    Assert-CloudRunCalls $result 'openai' 'gpt-6-luna' 'gpt-6-luna' -Partial
  }
  $result = Invoke-DeploymentScenario 'Secret upload failure never creates an environment file' -Environment $bothKeys -FailPrefix 'secrets versions add ' -ExpectFailure
  Assert-Deployment (@($result.Calls | Where-Object EnvironmentPath).Count -eq 0) "$($result.Name): deployment continued after failed secret upload."
  $script:passedChecks++
  Write-Host "PASS $($result.Name)"

  Write-Host "Offline deployment checks passed: $script:passedChecks scenarios; every gcloud call was a local mock; no API or deployment executed."
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
  if ($previousGcloudFunction) { Set-Item Function:\global:gcloud -Value $previousGcloudFunction.ScriptBlock }
  else { Remove-Item Function:\global:gcloud -ErrorAction SilentlyContinue }
  if ($previousMockState) { Set-Variable YztOfflineDeploymentState -Value $previousMockState.Value -Scope Global }
  else { Remove-Variable YztOfflineDeploymentState -Scope Global -ErrorAction SilentlyContinue }
  # This directory is created above and contains only the synthetic public config.
  if (Test-Path -LiteralPath $firebaseConfigPath) { Remove-Item -LiteralPath $firebaseConfigPath }
  if (Test-Path -LiteralPath $temporaryDirectory) { Remove-Item -LiteralPath $temporaryDirectory }
  if ($hadPreviousExitCode) { $global:LASTEXITCODE = $previousExitCode }
  else { Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }
}
