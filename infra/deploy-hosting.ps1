<#
Deploys only a Firebase Hosting rewrite to an existing public Cloud Run service.
Before running a real deployment, inspect this site's live release and confirm it
is empty or already belongs to this application. A Hosting release replaces that
site's existing configuration. ValidateOnly does not inspect cloud state.
After deployment, verify the Hosting URL before configuring application APP_URL.
#>
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{4,61}[a-z0-9]$')][string]$ProjectId,
  [Parameter(Mandatory=$true)][string]$FirebaseConfigPath,
  [ValidateSet('test','prod')][string]$Environment='test',
  [ValidatePattern('^[a-z][a-z0-9-]*[0-9]$')][string]$Region='asia-east1',
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$Environment = $Environment.ToLowerInvariant()
$webConfig = Get-Content -Raw -LiteralPath $FirebaseConfigPath | ConvertFrom-Json
if ([string]$webConfig.projectId -cne $ProjectId) {
  throw 'Firebase Web config projectId must exactly match ProjectId.'
}
$authDomain = "$ProjectId.firebaseapp.com"
if ([string]$webConfig.authDomain -cne $authDomain) {
  throw 'Firebase Web config authDomain must exactly match PROJECT_ID.firebaseapp.com.'
}
$hostingConfig = [ordered]@{
  hosting = [ordered]@{
    site = $ProjectId
    public = 'public'
    ignore = @('**/*', '**/.*', '**/.*/**')
    rewrites = @(
      [ordered]@{
        source = '**'
        run = [ordered]@{
          serviceId = "yzt-$Environment-web"
          region = $Region
        }
      }
    )
  }
}
if ($ValidateOnly) {
  [ordered]@{
    mode = 'validate-only'
    projectId = $ProjectId
    environment = $Environment
    authDomain = $authDomain
    hostingUrl = "https://$authDomain"
    firebaseToolsVersion = '15.34.0'
    existingSiteReviewRequired = $true
    cloudStateChecked = $false
    firebaseConfig = $hostingConfig
  } | ConvertTo-Json -Depth 10
  return
}
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  throw 'Install Node.js/npm so npx is available, and sign in to Firebase CLI first.'
}

# A dedicated project directory prevents repository files, .firebaserc targets,
# and other Firebase services from becoming part of this deployment.
$temporaryParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath
$temporaryName = 'yzt-hosting-' + [guid]::NewGuid().ToString('N')
$temporaryDirectory = [IO.Path]::GetFullPath((Join-Path $temporaryParent $temporaryName))
$configurationPath = Join-Path $temporaryDirectory 'firebase.json'
$locationPushed = $false
try {
  New-Item -ItemType Directory -Path (Join-Path $temporaryDirectory 'public') -Force | Out-Null
  [IO.File]::WriteAllText(
    $configurationPath,
    ($hostingConfig | ConvertTo-Json -Depth 10),
    [Text.UTF8Encoding]::new($false)
  )
  Push-Location -LiteralPath $temporaryDirectory
  $locationPushed = $true
  & npx --yes firebase-tools@15.34.0 deploy --only hosting --project $ProjectId --config $configurationPath --non-interactive
  if ($LASTEXITCODE -ne 0) {
    throw "Firebase Hosting deployment failed with exit code $LASTEXITCODE."
  }
  Write-Output "Hosting deployed to https://$authDomain. Verify it before changing APP_URL."
} finally {
  if ($locationPushed) { Pop-Location }
  if (Test-Path -LiteralPath $temporaryDirectory) {
    $resolvedDirectory = (Resolve-Path -LiteralPath $temporaryDirectory).ProviderPath
    $temporaryPrefix = $temporaryParent.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $directoryItem = Get-Item -LiteralPath $resolvedDirectory -Force
    if (
      -not $resolvedDirectory.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not $resolvedDirectory.Equals($temporaryDirectory, [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $resolvedDirectory) -cnotmatch '^yzt-hosting-[a-f0-9]{32}$' -or
      ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
    ) {
      throw 'Refusing to remove a Hosting temporary directory outside its verified temporary path.'
    }
    Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force
  }
}
