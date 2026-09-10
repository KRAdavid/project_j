param(
  [string]$RuntimeFile = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($RuntimeFile)) {
  $RuntimeFile = Join-Path $root 'ops/company-mode-runtime.json'
} elseif (-not [System.IO.Path]::IsPathRooted($RuntimeFile)) {
  $RuntimeFile = Join-Path $root $RuntimeFile
}

if (-not (Test-Path -LiteralPath $RuntimeFile)) {
  throw "RUNTIME_MANIFEST_NOT_FOUND: $RuntimeFile"
}

$runtime = Get-Content -LiteralPath $RuntimeFile -Raw | ConvertFrom-Json
if ($runtime.schemaVersion -ne 'COMPANY-MODE-RUNTIME-0.1') {
  throw "RUNTIME_MANIFEST_UNSUPPORTED: $RuntimeFile"
}

foreach ($property in @(
  @{ name = 'status'; value = 'RUNNING' },
  @{ name = 'stoppedAt'; value = $null },
  @{ name = 'stoppedProcesses'; value = @() }
)) {
  if ($runtime.PSObject.Properties.Name -notcontains $property.name) {
    $runtime | Add-Member -NotePropertyName $property.name -NotePropertyValue $property.value
  }
}

$stopped = @()
function Stop-StartedProcess([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  return $true
}

function Clear-StaleOperationLock {
  $lockPath = Join-Path $root 'ops/.operations-cycle.lock'
  if (-not (Test-Path -LiteralPath $lockPath)) { return }
  try {
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $lockPid = [int]$lock.pid
    if ($lockPid -le 0 -or -not (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
      # A dead lock owner cannot be running a cycle. Remove only this exact
      # known lock file; unknown live owners are always preserved.
      Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
    }
  } catch {
    # Malformed or inaccessible locks remain for human review.
  }
}
foreach ($entry in @(
  @{ name = 'supervisorPid'; label = 'company-supervisor' },
  @{ name = 'opsDaemonPid'; label = 'ops-daemon' },
  @{ name = 'serverPid'; label = 'server' }
)) {
  $pidValue = 0
  if ($null -ne $runtime.($entry.name)) {
    $pidValue = [int]$runtime.($entry.name)
  }
  if ($pidValue -le 0) { continue }
  if (Stop-StartedProcess $pidValue) {
    $stopped += "$($entry.label):$pidValue"
  }
}

# Backward compatibility for manifests created by the wrapper-based launcher.
if ($runtime.PSObject.Properties.Name -notcontains 'serverPid' -and $runtime.PSObject.Properties.Name -contains 'serverLauncherPid') {
  $legacyPid = [int]$runtime.serverLauncherPid
  if (Stop-StartedProcess $legacyPid) {
    $stopped += "server-launcher:$legacyPid"
  }
}

# server.ps1 is a wrapper. If its child Node process remains, terminate it only
# when the recorded port answers as this application's canonical health service.
$port = [int]$runtime.port
if ($port -gt 0) {
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -Method Get -TimeoutSec 2
        if ($health.service -eq 'raw-material-beta') {
          $ownerPid = [int]$listener.OwningProcess
          if (Stop-StartedProcess $ownerPid) {
            $stopped += "server-port:$ownerPid"
          }
        }
      } catch {
        # Unknown or unhealthy listeners are never terminated by this script.
      }
    }
    if ($listeners.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  }
}
Clear-StaleOperationLock

$runtime.status = 'STOPPED'
$runtime.stoppedAt = (Get-Date).ToUniversalTime().ToString('o')
$runtime.stoppedProcesses = $stopped
$runtime | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $RuntimeFile -Encoding UTF8
Write-Host "COMPANY_MODE_STOPPED: $($stopped -join ', ')"

