param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{4,61}[a-z0-9]$')][string]$ProjectId,
  [Parameter(Mandatory=$true)][string]$FirebaseConfigPath,
  [Parameter(Mandatory=$true)][string]$VapidKey,
  [ValidateSet('test','prod')][string]$Environment='test',
  [string]$Region='asia-east1'
)
$ErrorActionPreference='Stop'
function Gcloud { & gcloud @args; if ($LASTEXITCODE -ne 0) { throw "gcloud failed (exit $LASTEXITCODE)" } }
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install Google Cloud CLI and sign in first.' }
$webConfig = Get-Content -Raw -LiteralPath $FirebaseConfigPath | ConvertFrom-Json
if ($webConfig.projectId -ne $ProjectId) { throw 'Firebase config projectId must match ProjectId.' }
if (-not $env:NVIDIA_API_KEY) { throw 'Set NVIDIA_API_KEY in this terminal before deployment. Never put it in a command argument.' }
$name="yzt-$Environment"
$bucket="$ProjectId-$name-data"
$runtime="$name-runtime@$ProjectId.iam.gserviceaccount.com"
$caller="$name-caller@$ProjectId.iam.gserviceaccount.com"
$secret="$name-nvidia-key"
Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com identitytoolkit.googleapis.com firebase.googleapis.com storage.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com fcm.googleapis.com --project=$ProjectId
# Use a separate Google Cloud/Firebase project per environment, so Authentication and data are isolated.
$accountNames = @(Gcloud iam service-accounts list --project=$ProjectId --format='value(email)')
if ($runtime -notin $accountNames) { Gcloud iam service-accounts create "$name-runtime" --project=$ProjectId }
if ($caller -notin $accountNames) { Gcloud iam service-accounts create "$name-caller" --project=$ProjectId }
foreach ($role in @('roles/datastore.user','roles/cloudtasks.enqueuer','roles/firebaseauth.admin','roles/firebasecloudmessaging.admin')) {
  Gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$runtime" --role=$role --condition=None --quiet | Out-Null
}
Gcloud iam service-accounts add-iam-policy-binding $caller --project=$ProjectId --member="serviceAccount:$runtime" --role=roles/iam.serviceAccountUser --quiet | Out-Null
$buckets = @(Gcloud storage buckets list --project=$ProjectId --format='value(name)')
if ($bucket -notin $buckets -and "gs://$bucket" -notin $buckets) { Gcloud storage buckets create "gs://$bucket" --project=$ProjectId --location=$Region --uniform-bucket-level-access --public-access-prevention }
Gcloud storage buckets update "gs://$bucket" --lifecycle-file="$PSScriptRoot/storage-lifecycle.json"
Gcloud storage buckets add-iam-policy-binding "gs://$bucket" --member="serviceAccount:$runtime" --role=roles/storage.objectAdmin --quiet | Out-Null
$secrets = @(Gcloud secrets list --project=$ProjectId --format='value(name)')
if ($secret -notin $secrets -and "projects/$ProjectId/secrets/$secret" -notin $secrets) { Gcloud secrets create $secret --project=$ProjectId --replication-policy=automatic }
# stdin keeps the secret out of argv, generated YAML and console output.
$env:NVIDIA_API_KEY | & gcloud secrets versions add $secret --project=$ProjectId --data-file=- --quiet
if ($LASTEXITCODE -ne 0) { throw 'Secret upload failed.' }
Gcloud secrets add-iam-policy-binding $secret --project=$ProjectId --member="serviceAccount:$runtime" --role=roles/secretmanager.secretAccessor --quiet | Out-Null
$databases = @(Gcloud firestore databases list --project=$ProjectId --format='value(name)')
if (-not ($databases -match '/databases/\(default\)$')) { Gcloud firestore databases create --project=$ProjectId --database='(default)' --location=$Region --type=firestore-native }
$repos = @(Gcloud artifacts repositories list --project=$ProjectId --location=$Region --format='value(name)')
if (-not ($repos -match '/yaozhitong$')) { Gcloud artifacts repositories create yaozhitong --project=$ProjectId --location=$Region --repository-format=docker }
$image="$Region-docker.pkg.dev/$ProjectId/yaozhitong/app:$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Gcloud builds submit --project=$ProjectId --tag=$image .
$envFile=Join-Path ([System.IO.Path]::GetTempPath()) ("yzt-env-"+[guid]::NewGuid().ToString()+'.yaml')
try {
  $base=[ordered]@{APP_MODE='firebase';GOOGLE_CLOUD_PROJECT=$ProjectId;STORAGE_BUCKET=$bucket;NVIDIA_TEXT_MODEL='nvidia/nemotron-3.5-lightning-30b-a3b';NVIDIA_VISION_MODEL='nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';TASKS_LOCATION=$Region;TASKS_QUEUE="$name-ai";WORKER_SERVICE_ACCOUNT=$caller;FIREBASE_WEB_CONFIG=($webConfig|ConvertTo-Json -Compress);FIREBASE_VAPID_KEY=$VapidKey;DAILY_USER_LIMIT='20';DAILY_GLOBAL_LIMIT='200';SERVICE_ROLE='worker'}
  function SaveEnv { $lines = foreach ($entry in $base.GetEnumerator()) { '{0}: {1}' -f $entry.Key, (ConvertTo-Json -InputObject ([string]$entry.Value) -Compress) }; Set-Content -LiteralPath $envFile -Value $lines -Encoding utf8 }
  SaveEnv
  Gcloud run deploy "$name-worker" --project=$ProjectId --region=$Region --image=$image --service-account=$runtime --no-allow-unauthenticated --min=0 --max=2 --concurrency=2 --memory=1Gi --cpu=1 --timeout=600 --env-vars-file=$envFile --set-secrets="NVIDIA_API_KEY=$secret`:latest" --quiet
  $workerUrl=Gcloud run services describe "$name-worker" --project=$ProjectId --region=$Region --format='value(status.url)'
  Gcloud run services add-iam-policy-binding "$name-worker" --project=$ProjectId --region=$Region --member="serviceAccount:$caller" --role=roles/run.invoker --quiet | Out-Null
  $base.WORKER_URL=$workerUrl
  $base.SERVICE_ROLE='web'
  SaveEnv
  Gcloud run deploy "$name-web" --project=$ProjectId --region=$Region --image=$image --service-account=$runtime --allow-unauthenticated --min=0 --max=2 --concurrency=40 --memory=1Gi --cpu=1 --timeout=120 --env-vars-file=$envFile --set-secrets="NVIDIA_API_KEY=$secret`:latest" --quiet
  $webUrl=Gcloud run services describe "$name-web" --project=$ProjectId --region=$Region --format='value(status.url)'
  $base.APP_URL=$webUrl
  SaveEnv
  Gcloud run services update "$name-web" --project=$ProjectId --region=$Region --env-vars-file=$envFile --quiet
  $base.SERVICE_ROLE='worker'; SaveEnv
  Gcloud run services update "$name-worker" --project=$ProjectId --region=$Region --env-vars-file=$envFile --quiet
  $queues=@(Gcloud tasks queues list --project=$ProjectId --location=$Region --format='value(name)')
  if (-not ($queues -match "/$name-ai$")) { Gcloud tasks queues create "$name-ai" --project=$ProjectId --location=$Region --max-concurrent-dispatches=2 --max-dispatches-per-second=2 --max-attempts=3 }
  $jobs=@(Gcloud scheduler jobs list --project=$ProjectId --location=$Region --format='value(name)')
  $mode=if($jobs -match "/$name-tick$"){'update'}else{'create'}
  Gcloud scheduler jobs $mode http "$name-tick" --project=$ProjectId --location=$Region --schedule='* * * * *' --uri="$workerUrl/internal/tick" --http-method=POST --oidc-service-account-email=$caller --oidc-token-audience=$workerUrl --attempt-deadline=180s --quiet
  $catalogMode=if($jobs -match "/$name-catalog$"){'update'}else{'create'}
  Gcloud scheduler jobs $catalogMode http "$name-catalog" --project=$ProjectId --location=$Region --schedule='0 3 * * 0' --time-zone=Asia/Taipei --uri="$workerUrl/internal/catalog" --http-method=POST --oidc-service-account-email=$caller --oidc-token-audience=$workerUrl --attempt-deadline=300s --quiet
  $schedules=@(Gcloud firestore backups schedules list --project=$ProjectId --database='(default)' --format='value(name)')
  if ($schedules.Count -eq 0) { Gcloud firestore backups schedules create --project=$ProjectId --database='(default)' --retention=7d --recurrence=daily }
  Write-Host "Deployed: $webUrl"
  Write-Host 'Next: enable Google/Email sign-in, add this domain in Firebase Auth, deploy rules, import catalog/leaflets, bootstrap admin and configure billing alerts. See docs/DEPLOYMENT.md.'
} finally { if (Test-Path -LiteralPath $envFile) { Remove-Item -LiteralPath $envFile } }
