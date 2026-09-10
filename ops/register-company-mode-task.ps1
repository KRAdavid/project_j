param(
  [string]$TaskName = 'RawMaterialOS-CompanyMode',
  [switch]$ReplaceExisting
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcher = Join-Path $root 'ops/start-company-supervised.ps1'
$powershellCommand = (Get-Command powershell.exe -ErrorAction Stop).Source
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principalIdentity = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principalIdentity.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'SCHEDULED_TASK_ADMIN_REQUIRED: 관리자 권한 PowerShell에서 pnpm run ops:register를 다시 실행해야 합니다.'
}

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "SUPERVISED_LAUNCHER_NOT_FOUND: $launcher"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $ReplaceExisting) {
  throw "SCHEDULED_TASK_ALREADY_EXISTS: $TaskName. 기존 작업을 덮어쓰려면 -ReplaceExisting를 명시해야 합니다."
}
if ($existing -and $ReplaceExisting) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$actionArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$action = New-ScheduledTaskAction -Execute $powershellCommand -Argument $actionArguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 1)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Raw Material OS 감독형 베타 운영: health·SSE·AI 운영 데몬 감시 및 안전 복구' -ErrorAction Stop | Out-Null
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if (-not $registered) { throw "SCHEDULED_TASK_REGISTRATION_UNVERIFIED: $TaskName" }
Write-Host "COMPANY_MODE_TASK_REGISTERED: $TaskName"
Write-Host "trigger=AtLogOn launcher=$launcher"

