param(
  [int]$Port = 4173,
  [ValidateSet('simulation', 'staging', 'production')]
  [string]$AppEnv = 'simulation',
  [ValidateSet('memory', 'sqlite', 'postgresql')]
  [string]$PersistenceMode = 'memory',
  [string]$PersistenceFile = '',
  [int]$IntervalMs = 900000,
  [int]$CycleTimeoutMs = 600000,
  [string]$RuntimeFile = '',
  [string]$DaemonStatusFile = ''
)

# Company mode is an operational launcher, not a deployment or trading switch.
# It starts only the canonical API/SSE server and the evidence-producing daemon.
# Production still requires the application and readiness fail-closed gates.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node -ErrorAction Stop
$healthUrl = "http://127.0.0.1:$Port/api/health"
if ([string]::IsNullOrWhiteSpace($RuntimeFile)) {
  $RuntimeFile = Join-Path $root 'ops/company-mode-runtime.json'
} elseif (-not [System.IO.Path]::IsPathRooted($RuntimeFile)) {
  $RuntimeFile = Join-Path $root $RuntimeFile
}
if ([string]::IsNullOrWhiteSpace($DaemonStatusFile)) {
  $DaemonStatusFile = Join-Path $root 'ops/daemon-status.json'
} elseif (-not [System.IO.Path]::IsPathRooted($DaemonStatusFile)) {
  $DaemonStatusFile = Join-Path $root $DaemonStatusFile
}

if ($IntervalMs -lt 1000 -or $CycleTimeoutMs -lt 1000) {
  throw 'IntervalMs와 CycleTimeoutMs는 1000ms 이상이어야 합니다.'
}
$minimumCycleTimeoutMs = 300000
if ($CycleTimeoutMs -lt $minimumCycleTimeoutMs) {
  throw "CYCLE_TIMEOUT_TOO_SHORT: 회사형 자동 사이클은 최소 $minimumCycleTimeoutMs ms 제한이 필요합니다."
}

$existing = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
  $owners = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
  throw "PORT_IN_USE: $Port 포트가 이미 사용 중입니다. 기존 프로세스를 종료하지 않고 시작을 중단합니다. PID=$owners"
}

# A live daemon is a singleton control-plane worker. Do not create a second
# worker during a restart or operator handoff; the operation lock is a second
# line of defense, not a substitute for this startup guard.
if (Test-Path -LiteralPath $DaemonStatusFile) {
  try {
    $daemonStatus = Get-Content -LiteralPath $DaemonStatusFile -Raw | ConvertFrom-Json
    $daemonPidValue = [int]$daemonStatus.pid
    $daemonAgeMs = [int64]((Get-Date).ToUniversalTime() - [DateTime]::Parse($daemonStatus.updatedAt).ToUniversalTime()).TotalMilliseconds
    $daemonLiveStatus = @('RUNNING', 'CYCLE_RUNNING', 'WAITING') -contains [string]$daemonStatus.status
    if ($daemonLiveStatus -and $daemonAgeMs -ge 0 -and $daemonAgeMs -le (20 * 60 * 1000) -and (Get-Process -Id $daemonPidValue -ErrorAction SilentlyContinue)) {
      throw "DAEMON_ALREADY_RUNNING: PID=$daemonPidValue 상태=$($daemonStatus.status). 기존 데몬을 종료하지 않고 시작을 중단합니다."
    }
  } catch {
    if ($_.Exception.Message -like 'DAEMON_ALREADY_RUNNING:*') { throw }
    # A missing, malformed, or stale status file is not enough to terminate
    # an unknown process; the daemon's operation lock remains authoritative.
  }
}

$previousEnv = @{
  PORT = $env:PORT
  APP_ENV = $env:APP_ENV
  PERSISTENCE_MODE = $env:PERSISTENCE_MODE
  PERSISTENCE_FILE = $env:PERSISTENCE_FILE
  OPS_DAEMON_INTERVAL_MS = $env:OPS_DAEMON_INTERVAL_MS
  OPS_DAEMON_CYCLE_TIMEOUT_MS = $env:OPS_DAEMON_CYCLE_TIMEOUT_MS
  OPS_DAEMON_STATUS_PATH = $env:OPS_DAEMON_STATUS_PATH
  MONITOR_BASE_URL = $env:MONITOR_BASE_URL
  MONITOR_REQUIRE_DAEMON = $env:MONITOR_REQUIRE_DAEMON
  MONITOR_DAEMON_STATUS_PATH = $env:MONITOR_DAEMON_STATUS_PATH
}

$env:PORT = [string]$Port
$env:APP_ENV = $AppEnv
$env:PERSISTENCE_MODE = $PersistenceMode
if ([string]::IsNullOrWhiteSpace($PersistenceFile)) {
  Remove-Item Env:PERSISTENCE_FILE -ErrorAction SilentlyContinue
} else {
  $env:PERSISTENCE_FILE = $PersistenceFile
}
$env:OPS_DAEMON_INTERVAL_MS = [string]$IntervalMs
$env:OPS_DAEMON_CYCLE_TIMEOUT_MS = [string]$CycleTimeoutMs
$env:OPS_DAEMON_STATUS_PATH = $DaemonStatusFile
$env:OPS_DAEMON_RUN_ON_START = 'true'
$env:MONITOR_BASE_URL = "http://127.0.0.1:$Port"
$env:MONITOR_REQUIRE_DAEMON = 'true'
$env:MONITOR_DAEMON_STATUS_PATH = $DaemonStatusFile

$serverScript = Join-Path $root 'beta-app/server.mjs'
$daemonScript = Join-Path $root 'ops/ops-daemon.mjs'

$serverProcess = $null
$daemonProcess = $null
function Stop-StartedProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
}
function Stop-StartedServerByPort([int]$ServerPort) {
  for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
    $listeners = @(Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/api/health" -Method Get -TimeoutSec 2
        if ($health.service -eq 'raw-material-beta') {
          Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction SilentlyContinue
        }
      } catch {
        # Do not terminate an unknown service when identity cannot be verified.
      }
    }
    if ($listeners.Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  }
}
try {
  $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @($serverScript) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  $healthy = $false
  do {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3
      if ($health.service -eq 'raw-material-beta' -and $health.eventStream -eq 'SSE' -and $null -ne $health.persistence) {
        $healthy = $true
      }
    } catch {
      # The server may still be binding. The deadline below is the guardrail.
    }
  } while (-not $healthy -and (Get-Date) -lt $deadline)

  if (-not $healthy) {
    throw "SERVER_HEALTH_TIMEOUT: $healthUrl"
  }

  $daemonProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @($daemonScript) -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $runtime = [ordered]@{
    schemaVersion = 'COMPANY-MODE-RUNTIME-0.1'
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    status = 'RUNNING'
    appEnv = $AppEnv
    persistenceMode = $PersistenceMode
    port = $Port
    healthUrl = $healthUrl
    serverPid = $serverProcess.Id
    opsDaemonPid = $daemonProcess.Id
    intervalMs = $IntervalMs
    cycleTimeoutMs = $CycleTimeoutMs
    monitorBaseUrl = $env:MONITOR_BASE_URL
    daemonRequired = $true
    realTradingEnabled = $false
    externalNotificationSent = $false
    stopRule = '헬스체크 실패·릴리스 NO_GO·운영 사고 시 거래·계약·결제·공개 재개를 자동 승인하지 않는다.'
  }
  $runtime | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $RuntimeFile -Encoding UTF8
  Write-Host "COMPANY_MODE_STARTED: $healthUrl"
  Write-Host "serverPid=$($serverProcess.Id) opsDaemonPid=$($daemonProcess.Id) runtime=$RuntimeFile"
} catch {
  if ($daemonProcess -and -not $daemonProcess.HasExited) {
    Stop-StartedProcessTree $daemonProcess.Id
  }
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-StartedProcessTree $serverProcess.Id
  }
  Stop-StartedServerByPort $Port
  throw
} finally {
  foreach ($name in $previousEnv.Keys) {
    $value = $previousEnv[$name]
    if ($null -eq $value) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" $value
    }
  }
}

