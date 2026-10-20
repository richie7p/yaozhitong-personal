# Configuration only: no cloud commands, API requests, files or secret values in the result.
function Get-YztAiDeploymentConfig {
  param(
    [ValidateSet('openai','nvidia')][string]$AiProvider='openai',
    [string]$TextModel,
    [string]$VisionModel,
    [ValidateSet('test','prod')][string]$Environment='test'
  )

  $AiProvider = $AiProvider.ToLowerInvariant()
  $Environment = $Environment.ToLowerInvariant()
  $prefix = $AiProvider.ToUpperInvariant()
  $defaultModel = if ($AiProvider -eq 'openai') { 'gpt-6-luna' } else { 'nvidia/nemotron-3.5-super-vl-120b-a12b' }
  $models = @{}
  foreach ($kind in @('TEXT','VISION')) {
    $model = if ($kind -eq 'TEXT') { $TextModel } else { $VisionModel }
    if (-not $model) { $model = [Environment]::GetEnvironmentVariable("AI_${kind}_MODEL", 'Process') }
    if (-not $model) { $model = [Environment]::GetEnvironmentVariable("${prefix}_${kind}_MODEL", 'Process') }
    if (-not $model) { $model = $defaultModel }
    if ($model.Length -gt 200 -or $model -cnotmatch '\A[a-zA-Z0-9][a-zA-Z0-9._:/-]*\z' -or $model -match '^(sk-|nvapi-)') {
      # Do not echo invalid input: it might be a key pasted into the model field.
      throw 'Invalid AI model ID. Use a model name, without whitespace or credentials.'
    }
    $models[$kind] = $model
  }

  $keyName = "${prefix}_API_KEY"
  $settings = [ordered]@{
    AI_PROVIDER = $AiProvider
    AI_TEXT_MODEL = $models.TEXT
    AI_VISION_MODEL = $models.VISION
    AI_REQUEST_TIMEOUT_MS = '45000'
    AI_PRIMARY_TIMEOUT_MS = '22000'
    AI_TEXT_PRIMARY_TIMEOUT_MS = '12000'
    AI_JOB_TIMEOUT_MS = '120000'
    AI_TEXT_MAX_TOKENS = '2400'
    AI_VISION_MAX_TOKENS = '2600'
  }
  $settings["${prefix}_BASE_URL"] = if ($AiProvider -eq 'openai') { 'https://api.openai.com/v1' } else { 'https://integrate.api.nvidia.com/v1' }

  [pscustomobject]@{
    aiProvider = $AiProvider
    textModel = $models.TEXT
    visionModel = $models.VISION
    secretName = "yzt-$Environment-$AiProvider-key"
    keyEnvironmentVariable = $keyName
    keyConfigured = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($keyName, 'Process'))
    environmentVariables = $settings
  }
}
