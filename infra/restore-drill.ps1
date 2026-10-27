param(
  [Parameter(Mandatory=$true)][string]$PlanPath,
  [Parameter(Mandatory=$true)][string]$ReceiptDirectory,
  [switch]$ExecuteRestore
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedPlan = (Resolve-Path -LiteralPath $PlanPath).Path
$receiptPath = [System.IO.Path]::GetFullPath($ReceiptDirectory)
$runner = Join-Path $projectRoot 'tools/ops-restore.ts'
$arguments = @('--import', 'tsx', $runner, '--plan', $resolvedPlan, '--receipts', $receiptPath)
if ($ExecuteRestore) { $arguments += '--execute' }
# Read-only preflight by default. The reviewed plan fixes both full resources.
# One intent journal precedes at most one POST; no delete/app/Auth/IAM changes.
Push-Location -LiteralPath $projectRoot
try {
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Restore preflight/operation failed; inspect the private journal before any follow-up. Never blindly retry.' }
} finally { Pop-Location }
