param([Parameter(Mandatory=$true)][string]$ProjectId,[Parameter(Mandatory=$true)][string]$BackupResource,[Parameter(Mandatory=$true)][ValidatePattern('^restore-drill-[a-z0-9-]+$')][string]$DestinationDatabase)
$ErrorActionPreference='Stop'
if ($BackupResource -notlike "projects/$ProjectId/locations/*/backups/*") { throw 'Backup must belong to the specified project.' }
# Always restore into a new database, never overwrite the live database.
gcloud firestore databases restore --project=$ProjectId --source-backup=$BackupResource --destination-database=$DestinationDatabase
if ($LASTEXITCODE -ne 0) { throw 'Restore failed.' }
Write-Host "Restored into $DestinationDatabase. Verify document counts and a test account export before recording the drill result. This script does not delete the restored database."
