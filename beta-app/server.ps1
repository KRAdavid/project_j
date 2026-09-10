param(
  [int]$Port = 4173,
  [ValidateSet('simulation', 'staging', 'production')]
  [string]$AppEnv = 'simulation',
  [ValidateSet('memory', 'sqlite', 'postgresql')]
  [string]$PersistenceMode = 'memory',
  [string]$PersistenceFile = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $PSScriptRoot).Path
$nodeCommand = Get-Command node -ErrorAction Stop

$env:PORT = [string]$Port
$env:APP_ENV = $AppEnv
$env:PERSISTENCE_MODE = $PersistenceMode
if ([string]::IsNullOrWhiteSpace($PersistenceFile)) {
  Remove-Item Env:PERSISTENCE_FILE -ErrorAction SilentlyContinue
} else {
  $env:PERSISTENCE_FILE = $PersistenceFile
}

Write-Host "Raw Material OS server: http://127.0.0.1:$Port/"
Write-Host "Environment: $AppEnv · persistence: $PersistenceMode"
Write-Host 'Canonical runtime: beta-app/server.mjs (API, SSE, ledger and fail-closed gates)'

Push-Location $root
try {
  & $nodeCommand.Source (Join-Path $root 'server.mjs')
  exit $LASTEXITCODE
} finally {
  Pop-Location
}

