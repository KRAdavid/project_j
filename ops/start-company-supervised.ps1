param(
  [int]$Port = 4173,
  [ValidateSet('simulation', 'staging', 'production')]
  [string]$AppEnv = 'simulation',
  [ValidateSet('memory', 'sqlite', 'postgresql')]
  [string]$PersistenceMode = 'memory',
  [string]$PersistenceFile = '',
  [int]$SupervisorIntervalMs = 5000,
  [int]$DaemonIntervalMs = 900000,
  [int]$CycleTimeoutMs = 600000
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node -ErrorAction Stop
$healthUrl = "http://127.0.0.1:$Port/api/health"
$runtimeFile = Join-Path $root 'ops/company-mode-runtime.json'
$statusFile = Join-Path $root 'ops/company-supervisor-status.json'
$daemonStatusFile = Join-Path $root 'ops/daemon-status.json'
$supervisorStdoutLog = Join-Path $root 'ops/company-supervisor.log'
$supervisorStderrLog = Join-Path $root 'ops/company-supervisor.error.log'
# company-supervisor.mjs writes realTradingEnabled = false into the runtime manifest.

if ($SupervisorIntervalMs -lt 1000 -or $DaemonIntervalMs -lt 1000 -or $CycleTimeoutMs -lt 1000) {
  throw '감독자·데몬·사이클 주기는 1000ms 이상이어야 합니다.'
}

try {
  $existingHealth = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
  if ($existingHealth.service -eq 'raw-material-beta') {
    throw "COMPANY_MODE_ALREADY_RUNNING: $healthUrl"
  }
} catch {
  if ($_.Exception.Message -like 'COMPANY_MODE_ALREADY_RUNNING:*') { throw }
}

if (Test-Path -LiteralPath $statusFile) {
  try {
    $existing = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
    $existingPid = [int]$existing.pid
    $existingLive = @('STARTING', 'RUNNING', 'DEGRADED') -contains [string]$existing.status
    if ($existingLive -and $existingPid -gt 0 -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
      throw "SUPERVISOR_ALREADY_RUNNING: PID=$existingPid"
    }
  } catch {
    if ($_.Exception.Message -like 'SUPERVISOR_ALREADY_RUNNING:*') { throw }
  }
}

$env:COMPANY_PORT = [string]$Port
$env:APP_ENV = $AppEnv
$env:PERSISTENCE_MODE = $PersistenceMode
$env:COMPANY_SUPERVISOR_INTERVAL_MS = [string]$SupervisorIntervalMs
$env:OPS_DAEMON_INTERVAL_MS = [string]$DaemonIntervalMs
$env:OPS_DAEMON_CYCLE_TIMEOUT_MS = [string]$CycleTimeoutMs
$env:OPS_DAEMON_STATUS_PATH = $daemonStatusFile
$env:OPS_DAEMON_RUN_ON_START = 'true'
$env:MONITOR_REQUIRE_SUPERVISOR = 'true'
$env:MONITOR_SUPERVISOR_STATUS_PATH = $statusFile
if ([string]::IsNullOrWhiteSpace($PersistenceFile)) {
  Remove-Item Env:PERSISTENCE_FILE -ErrorAction SilentlyContinue
} else {
  $env:PERSISTENCE_FILE = $PersistenceFile
}

$supervisor = $null
try {
  $supervisor = Start-Process -FilePath $nodeCommand.Source -ArgumentList @((Join-Path $root 'ops/company-supervisor.mjs')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $supervisorStdoutLog -RedirectStandardError $supervisorStderrLog -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  $healthy = $false
  do {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3
      if ($health.service -eq 'raw-material-beta' -and $health.eventStream -eq 'SSE') { $healthy = $true }
    } catch {}
  } while (-not $healthy -and (Get-Date) -lt $deadline)

  if (-not $healthy) { throw "SUPERVISED_SERVER_HEALTH_TIMEOUT: $healthUrl" }
  Write-Host "COMPANY_MODE_SUPERVISED_STARTED: $healthUrl"
  Write-Host "supervisorPid=$($supervisor.Id) runtime=$runtimeFile status=$statusFile"
} catch {
  if ($supervisor -and -not $supervisor.HasExited) {
    Stop-Process -Id $supervisor.Id -Force -ErrorAction SilentlyContinue
  }
  throw
}

