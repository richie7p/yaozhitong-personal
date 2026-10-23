param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{4,61}[a-z0-9]$')][string]$ProjectId,
  [Parameter(Mandatory=$true)][string]$FirebaseConfigPath,
  [Parameter(Mandatory=$true)][string]$VapidKey,
  [string]$GoogleOAuthClientId=$env:GOOGLE_OAUTH_CLIENT_ID,
  [string]$PublicAppUrl='',
  [ValidateSet('test','prod')][string]$Environment='test',
  [string]$Region='asia-east1',
  [ValidateSet('openai','nvidia')][string]$AiProvider='openai',
  [string]$TextModel,
  [string]$VisionModel,
  [string]$TextReasoningEffort='',
  [switch]$ValidateOnly
)
$ErrorActionPreference='Stop'
if ($GoogleOAuthClientId -notmatch '^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$') {
  throw 'Set GoogleOAuthClientId (or GOOGLE_OAUTH_CLIENT_ID) to the Google sign-in Web client ID from this Firebase project.'
}
if ($PublicAppUrl) {
  $publicOrigin = $null
  # Check the literal shape before Uri normalization can erase dot-segments,
  # backslashes or an empty query/fragment. Never echo rejected input.
  if ($PublicAppUrl -notmatch '\Ahttps://[^/?#@\\\s]+/?\z' -or
      -not [Uri]::TryCreate($PublicAppUrl, [UriKind]::Absolute, [ref]$publicOrigin) -or
      $publicOrigin.Scheme -ne 'https' -or -not $publicOrigin.Host -or
      $publicOrigin.UserInfo -or $publicOrigin.Query -or $publicOrigin.Fragment -or
      $publicOrigin.AbsolutePath -ne '/') {
    throw 'PublicAppUrl must be an HTTPS origin without credentials, path, query or fragment.'
  }
  $PublicAppUrl = $publicOrigin.GetLeftPart([UriPartial]::Authority)
}
$Environment = $Environment.ToLowerInvariant()
. (Join-Path $PSScriptRoot 'deploy-config.ps1')
$webConfig = Get-Content -Raw -LiteralPath $FirebaseConfigPath | ConvertFrom-Json
if ($webConfig.projectId -ne $ProjectId) { throw 'Firebase config projectId must match ProjectId.' }
$ai = Get-YztAiDeploymentConfig -AiProvider $AiProvider -TextModel $TextModel -VisionModel $VisionModel -TextReasoningEffort $TextReasoningEffort -Environment $Environment
if ($ValidateOnly) {
  [ordered]@{
    validationPassed = $true
    cloudCommandsExecuted = 0
    aiProvider = $ai.aiProvider
    textModel = $ai.textModel
    visionModel = $ai.visionModel
    textReasoningEffort = $ai.environmentVariables.AI_TEXT_REASONING_EFFORT
    secretName = $ai.secretName
    keyEnvironmentVariable = $ai.keyEnvironmentVariable
    keyConfigured = $ai.keyConfigured
    googleOAuthClientConfigured = $true
    publicAppUrl = $PublicAppUrl
  } | ConvertTo-Json
  return
}
if (-not $ai.keyConfigured) { throw "Set $($ai.keyEnvironmentVariable) in this terminal before deployment. Never put it in a command argument." }
function Invoke-Gcloud { & gcloud @args; if ($LASTEXITCODE -ne 0) { throw "gcloud failed (exit $LASTEXITCODE)" } }
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install Google Cloud CLI and sign in first.' }
$name="yzt-$Environment"
$bucket="$ProjectId-$name-data"
$buildBucket="$ProjectId-$name-build"
$runtime="$name-runtime@$ProjectId.iam.gserviceaccount.com"
$caller="$name-caller@$ProjectId.iam.gserviceaccount.com"
$builder="$name-build@$ProjectId.iam.gserviceaccount.com"
$secret=$ai.secretName
$secretBinding="$($ai.keyEnvironmentVariable)=$secret`:latest"
Invoke-Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com identitytoolkit.googleapis.com firebase.googleapis.com storage.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com fcm.googleapis.com iam.googleapis.com --project=$ProjectId
# Use a separate Google Cloud/Firebase project per environment, so Authentication and data are isolated.
$accountNames = @(Invoke-Gcloud iam service-accounts list --project=$ProjectId --format='value(email)')
if ($runtime -notin $accountNames) { Invoke-Gcloud iam service-accounts create "$name-runtime" --project=$ProjectId }
if ($caller -notin $accountNames) { Invoke-Gcloud iam service-accounts create "$name-caller" --project=$ProjectId }
if ($builder -notin $accountNames) { Invoke-Gcloud iam service-accounts create "$name-build" --project=$ProjectId }
foreach ($role in @('roles/datastore.user','roles/cloudtasks.enqueuer','roles/firebaseauth.admin','roles/firebasecloudmessaging.admin')) {
  Invoke-Gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$runtime" --role=$role --condition=None --quiet | Out-Null
}
Invoke-Gcloud iam service-accounts add-iam-policy-binding $caller --project=$ProjectId --member="serviceAccount:$runtime" --role=roles/iam.serviceAccountUser --quiet | Out-Null
$buckets = @(Invoke-Gcloud storage buckets list --project=$ProjectId --format='value(name)')
if ($bucket -notin $buckets -and "gs://$bucket" -notin $buckets) { Invoke-Gcloud storage buckets create "gs://$bucket" --project=$ProjectId --location=$Region --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0 }
# Photos are temporary. Disable the seven-day soft-delete default before any
# application upload; lifecycle deletion alone would retain billable copies.
Invoke-Gcloud storage buckets update "gs://$bucket" --soft-delete-duration=0 --lifecycle-file="$PSScriptRoot/storage-lifecycle.json"
Invoke-Gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member="serviceAccount:$runtime" --role=roles/storage.objectAdmin --quiet | Out-Null
$secrets = @(Invoke-Gcloud secrets list --project=$ProjectId --format='value(name)')
if ($secret -notin $secrets -and "projects/$ProjectId/secrets/$secret" -notin $secrets) { Invoke-Gcloud secrets create $secret --project=$ProjectId --replication-policy=automatic }
# stdin keeps the secret out of argv, generated YAML and console output.
[Environment]::GetEnvironmentVariable($ai.keyEnvironmentVariable, 'Process').Trim() | & gcloud secrets versions add $secret --project=$ProjectId --data-file=- --quiet
if ($LASTEXITCODE -ne 0) { throw 'Secret upload failed.' }
Invoke-Gcloud secrets add-iam-policy-binding $secret --project=$ProjectId --member="serviceAccount:$runtime" --role=roles/secretmanager.secretAccessor --quiet | Out-Null
$databases = @(Invoke-Gcloud firestore databases list --project=$ProjectId --format='value(name)')
if (-not ($databases -match '/databases/\(default\)$')) { Invoke-Gcloud firestore databases create --project=$ProjectId --database='(default)' --location=$Region --type=firestore-native }
# A new reminder worker must not replace the running service while its due-query
# indexes are missing or still building. This checks readiness; it never creates
# or changes indexes, and ValidateOnly returns before any cloud access above.
function Get-YztIndexSignature {
  param($Index, [switch]$CloudResult)
  $collection = [string]$Index.collectionGroup
  if (-not $collection -and [string]$Index.name -match '/collectionGroups/([^/]+)/indexes/[^/]+$') {
    $collection = [Uri]::UnescapeDataString($Matches[1])
  }
  if (-not $collection -or -not $Index.queryScope) { return $null }
  $fields = @($Index.fields)
  # Firestore appends a document-name field in the last ordered field's
  # direction. Ignore only that automatic suffix, preserving explicit ordering.
  if ($CloudResult -and $fields.Count -gt 1 -and $fields[-1].fieldPath -ceq '__name__' -and $fields[-1].order -ceq $fields[-2].order) {
    $fields = @($fields[0..($fields.Count - 2)])
  }
  $specifications = @(foreach ($field in $fields) {
    [ordered]@{
      fieldPath = [string]$field.fieldPath
      order = [string]$field.order
      arrayConfig = [string]$field.arrayConfig
      vectorConfig = $field.vectorConfig
    }
  })
  [ordered]@{
    collectionGroup = $collection
    queryScope = [string]$Index.queryScope
    fields = $specifications
  } | ConvertTo-Json -Compress -Depth 10
}
$indexConfiguration = Get-Content -Raw -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'firestore.indexes.json') | ConvertFrom-Json
$indexJson = (Invoke-Gcloud firestore indexes composite list --database='(default)' --project=$ProjectId --format=json) -join [Environment]::NewLine
try { $parsedIndexes = $indexJson | ConvertFrom-Json; $cloudIndexes = @($parsedIndexes) }
catch { throw 'Cannot verify Firestore index readiness: gcloud returned invalid JSON. No application build or service deployment was started.' }
$readyIndexSignatures = @(foreach ($index in $cloudIndexes) {
  if ($index.state -ceq 'READY') { Get-YztIndexSignature $index -CloudResult }
})
$unreadyIndexes = @(foreach ($index in $indexConfiguration.indexes) {
  $signature = Get-YztIndexSignature $index
  if (-not $signature -or $readyIndexSignatures -cnotcontains $signature) {
    "$($index.collectionGroup) [$((@($index.fields | ForEach-Object fieldPath)) -join ', ')]"
  }
})
if ($unreadyIndexes.Count -gt 0) {
  throw "Required Firestore indexes are missing or not READY: $($unreadyIndexes -join '; '). From the repository root, run: npx firebase-tools deploy --only firestore:indexes --project $ProjectId . Wait until these indexes show READY, then rerun this script. No application build or service deployment was started."
}
$repos = @(Invoke-Gcloud artifacts repositories list --project=$ProjectId --location=$Region --format='value(name)')
if (-not ($repos -match '/yaozhitong$')) { Invoke-Gcloud artifacts repositories create yaozhitong --project=$ProjectId --location=$Region --repository-format=docker }
$image="$Region-docker.pkg.dev/$ProjectId/yaozhitong/app:$(Get-Date -Format 'yyyyMMdd-HHmmss')"
# A dedicated builder can access only its staging/log bucket and image
# repository, not application data, secrets, Firestore, or runtime deployment.
if ($buildBucket -notin $buckets -and "gs://$buildBucket" -notin $buckets) { Invoke-Gcloud storage buckets create "gs://$buildBucket" --project=$ProjectId --location=$Region --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0 }
Invoke-Gcloud storage buckets add-iam-policy-binding "gs://$buildBucket" --member="serviceAccount:$builder" --role=roles/storage.objectAdmin --quiet | Out-Null
# Cloud Build validates the staging/log bucket itself before reading objects.
# Object Admin does not include storage.buckets.get; limit metadata access to
# this build bucket rather than granting project-wide Storage permissions.
Invoke-Gcloud storage buckets add-iam-policy-binding "gs://$buildBucket" --member="serviceAccount:$builder" --role=roles/storage.bucketViewer --quiet | Out-Null
Invoke-Gcloud artifacts repositories add-iam-policy-binding yaozhitong --project=$ProjectId --location=$Region --member="serviceAccount:$builder" --role=roles/artifactregistry.writer --quiet | Out-Null
$buildConfigFile=Join-Path ([System.IO.Path]::GetTempPath()) ("yzt-build-"+[guid]::NewGuid().ToString()+'.json')
$buildLifecycleFile=Join-Path ([System.IO.Path]::GetTempPath()) ("yzt-build-lifecycle-"+[guid]::NewGuid().ToString()+'.json')
try {
  @{ rule = @(@{ action = @{ type = 'Delete' }; condition = @{ age = 7 } }) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $buildLifecycleFile -Encoding utf8
  Invoke-Gcloud storage buckets update "gs://$buildBucket" --soft-delete-duration=0 --lifecycle-file=$buildLifecycleFile
  # User-managed build accounts require user-owned log storage or Cloud
  # Logging. GCS_ONLY avoids requiring project-wide log-writing permissions.
  @{
    steps = @(@{ name = 'gcr.io/cloud-builders/docker'; args = @('build', '--tag', $image, '.') })
    images = @($image)
    options = @{ logging = 'GCS_ONLY' }
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $buildConfigFile -Encoding utf8
  Invoke-Gcloud builds submit --project=$ProjectId --region=$Region --service-account="projects/$ProjectId/serviceAccounts/$builder" --gcs-source-staging-dir="gs://$buildBucket/source" --gcs-log-dir="gs://$buildBucket/logs" --config=$buildConfigFile (Split-Path -Parent $PSScriptRoot)
} finally {
  foreach ($temporaryFile in @($buildConfigFile, $buildLifecycleFile)) {
    if (Test-Path -LiteralPath $temporaryFile) { Remove-Item -LiteralPath $temporaryFile }
  }
}
$envFile=Join-Path ([System.IO.Path]::GetTempPath()) ("yzt-env-"+[guid]::NewGuid().ToString()+'.yaml')
try {
  $base=[ordered]@{APP_MODE='firebase';GOOGLE_CLOUD_PROJECT=$ProjectId;STORAGE_BUCKET=$bucket;TASKS_LOCATION=$Region;TASKS_QUEUE="$name-ai";WORKER_SERVICE_ACCOUNT=$caller;FIREBASE_WEB_CONFIG=($webConfig|ConvertTo-Json -Compress);FIREBASE_VAPID_KEY=$VapidKey;DAILY_USER_LIMIT='20';DAILY_GLOBAL_LIMIT='1000';PUBLIC_ACCESS_MODE='verified';SERVICE_ROLE='worker'}
  $base.GOOGLE_OAUTH_CLIENT_ID=$GoogleOAuthClientId
  if ($PublicAppUrl) { $base.APP_URL=$PublicAppUrl }
  foreach ($entry in $ai.environmentVariables.GetEnumerator()) { $base[$entry.Key] = $entry.Value }
  function SaveEnv { $lines = foreach ($entry in $base.GetEnumerator()) { '{0}: {1}' -f $entry.Key, (ConvertTo-Json -InputObject ([string]$entry.Value) -Compress) }; Set-Content -LiteralPath $envFile -Value $lines -Encoding utf8 }
  SaveEnv
  Invoke-Gcloud run deploy "$name-worker" --project=$ProjectId --region=$Region --image=$image --service-account=$runtime --no-allow-unauthenticated --min=0 --max=2 --concurrency=2 --memory=1Gi --cpu=1 --timeout=600 --env-vars-file=$envFile --set-secrets="$secretBinding" --quiet
  $workerUrl=Invoke-Gcloud run services describe "$name-worker" --project=$ProjectId --region=$Region --format='value(status.url)'
  Invoke-Gcloud run services add-iam-policy-binding "$name-worker" --project=$ProjectId --region=$Region --member="serviceAccount:$caller" --role=roles/run.invoker --quiet | Out-Null
  $base.WORKER_URL=$workerUrl
  $base.SERVICE_ROLE='web'
  SaveEnv
  Invoke-Gcloud run deploy "$name-web" --project=$ProjectId --region=$Region --image=$image --service-account=$runtime --allow-unauthenticated --min=0 --max=2 --concurrency=40 --memory=1Gi --cpu=1 --timeout=120 --env-vars-file=$envFile --set-secrets="$secretBinding" --quiet
  $webUrl=Invoke-Gcloud run services describe "$name-web" --project=$ProjectId --region=$Region --format='value(status.url)'
  $base.APP_URL=if($PublicAppUrl){$PublicAppUrl}else{$webUrl}
  SaveEnv
  Invoke-Gcloud run services update "$name-web" --project=$ProjectId --region=$Region --env-vars-file=$envFile --set-secrets=$secretBinding --quiet
  $base.SERVICE_ROLE='worker'; SaveEnv
  Invoke-Gcloud run services update "$name-worker" --project=$ProjectId --region=$Region --env-vars-file=$envFile --set-secrets=$secretBinding --quiet
  $queues=@(Invoke-Gcloud tasks queues list --project=$ProjectId --location=$Region --format='value(name)')
  if (-not ($queues -match "/$name-ai$")) { Invoke-Gcloud tasks queues create "$name-ai" --project=$ProjectId --location=$Region --max-concurrent-dispatches=2 --max-dispatches-per-second=2 --max-attempts=3 }
  # Named-task recovery needs only BASIC task existence reads on this queue.
  Invoke-Gcloud tasks queues add-iam-policy-binding "$name-ai" --project=$ProjectId --location=$Region --member="serviceAccount:$runtime" --role=roles/cloudtasks.viewer --quiet | Out-Null
  $jobs=@(Invoke-Gcloud scheduler jobs list --project=$ProjectId --location=$Region --format='value(name)')
  $mode=if($jobs -match "/$name-tick$"){'update'}else{'create'}
  Invoke-Gcloud scheduler jobs $mode http "$name-tick" --project=$ProjectId --location=$Region --schedule='* * * * *' --uri="$workerUrl/internal/tick" --http-method=POST --oidc-service-account-email=$caller --oidc-token-audience=$workerUrl --attempt-deadline=180s --quiet
  $catalogMode=if($jobs -match "/$name-catalog$"){'update'}else{'create'}
  Invoke-Gcloud scheduler jobs $catalogMode http "$name-catalog" --project=$ProjectId --location=$Region --schedule='0 3 * * 0' --time-zone=Asia/Taipei --uri="$workerUrl/internal/catalog" --http-method=POST --oidc-service-account-email=$caller --oidc-token-audience=$workerUrl --attempt-deadline=300s --quiet
  $schedules=@(Invoke-Gcloud firestore backups schedules list --project=$ProjectId --database='(default)' --format='value(name)')
  if ($schedules.Count -eq 0) { Invoke-Gcloud firestore backups schedules create --project=$ProjectId --database='(default)' --retention=7d --recurrence=daily }
  Write-Host "Deployed: $($base.APP_URL)"
  Write-Host 'Next: enable Google/Email sign-in, add this domain in Firebase Auth, deploy rules, import catalog/leaflets, bootstrap admin and configure billing alerts. See docs/DEPLOYMENT.md.'
} finally { if (Test-Path -LiteralPath $envFile) { Remove-Item -LiteralPath $envFile } }
