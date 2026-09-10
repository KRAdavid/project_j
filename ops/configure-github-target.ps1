param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryUrl,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^/\s]+/[^/\s]+$')]
  [string]$Repository,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^\s]+$')]
  [string]$BaseBranch,
  [switch]$ReplaceOrigin
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$repositoryUrlValue = $RepositoryUrl.Trim()
$scpStyleSsh = $repositoryUrlValue -match '^git@github\.com:[^/\s]+/[^/\s]+(?:\.git)?$'
if (-not $scpStyleSsh) {
  try {
    $uri = [System.Uri]$repositoryUrlValue
  } catch {
    throw 'GITHUB_TARGET_URL_INVALID: GitHub HTTPS 또는 SSH URL을 입력해야 합니다.'
  }

  if ($uri.Scheme -notin @('https', 'ssh', 'git')) {
    throw 'GITHUB_TARGET_URL_INVALID: HTTPS 또는 SSH GitHub URL만 허용합니다.'
  }
  if ($uri.Host -and $uri.Host -ne 'github.com') {
    throw 'GITHUB_TARGET_HOST_INVALID: github.com 저장소만 허용합니다.'
  }
}

$git = Get-Command git -ErrorAction Stop
$originResult = $null
try { $originResult = & $git.Source -C $root remote get-url origin 2>$null } catch { $originResult = $null }
$origin = if ($LASTEXITCODE -eq 0 -and $null -ne $originResult) { [string]$originResult } else { '' }

function Get-GitHubRepository([string]$remote) {
  $remoteValue = if ($null -eq $remote) { '' } else { [string]$remote }
  $value = $remoteValue.Trim() -replace '\.git$', ''
  if ($value -match '(?:github\.com[/:])([^/]+/[^/]+)$') { return $Matches[1] }
  return ''
}

$existingRepository = Get-GitHubRepository $origin
$targetRepository = $Repository.Trim()
if ($origin -and -not $existingRepository) {
  if (-not $ReplaceOrigin) {
    throw 'GITHUB_ORIGIN_INVALID: 기존 origin이 GitHub 저장소가 아닙니다. 덮어쓰려면 -ReplaceOrigin을 명시해야 합니다.'
  }
  & $git.Source -C $root remote set-url origin $RepositoryUrl
  if ($LASTEXITCODE -ne 0) { throw 'GITHUB_ORIGIN_UPDATE_FAILED: 기존 origin을 변경하지 못했습니다.' }
} elseif ($existingRepository -and $existingRepository.ToLowerInvariant() -ne $targetRepository.ToLowerInvariant()) {
  if (-not $ReplaceOrigin) {
    throw "GITHUB_ORIGIN_MISMATCH: origin=$existingRepository target=$targetRepository. 덮어쓰려면 -ReplaceOrigin을 명시해야 합니다."
  }
  & $git.Source -C $root remote set-url origin $RepositoryUrl
  if ($LASTEXITCODE -ne 0) { throw 'GITHUB_ORIGIN_UPDATE_FAILED: 기존 origin을 변경하지 못했습니다.' }
} elseif (-not $origin) {
  & $git.Source -C $root remote add origin $RepositoryUrl
  if ($LASTEXITCODE -ne 0) { throw 'GITHUB_ORIGIN_ADD_FAILED: origin을 추가하지 못했습니다.' }
}

$verifiedOriginResult = & $git.Source -C $root remote get-url origin
if ($LASTEXITCODE -ne 0) { throw 'GITHUB_TARGET_VERIFY_FAILED: origin 조회에 실패했습니다. 외부 쓰기를 시작하지 않습니다.' }
$verifiedOrigin = [string]$verifiedOriginResult
if ((Get-GitHubRepository $verifiedOrigin).ToLowerInvariant() -ne $targetRepository.ToLowerInvariant()) {
  throw 'GITHUB_TARGET_VERIFY_FAILED: origin과 지정 저장소가 일치하지 않습니다. 외부 쓰기를 시작하지 않습니다.'
}

$targetConfigPath = Join-Path $root 'ops/github-target.json'
@{
  schemaVersion = 'GITHUB-TARGET-CONFIG-0.1'
  repository = $targetRepository
  remote = $verifiedOrigin.Trim()
  baseBranch = $BaseBranch.Trim()
  configuredAt = (Get-Date).ToUniversalTime().ToString('o')
  externalWritesPerformed = $false
} | ConvertTo-Json | Set-Content -LiteralPath $targetConfigPath -Encoding UTF8

$env:GITHUB_REPOSITORY = $targetRepository
$env:GITHUB_BASE_BRANCH = $BaseBranch.Trim()
$node = Get-Command node -ErrorAction Stop
$preflight = & $node.Source (Join-Path $root 'ops/github-target-preflight.mjs') --strict
if ($LASTEXITCODE -ne 0) {
  throw "GITHUB_TARGET_PREFLIGHT_FAILED: $preflight"
}

Write-Host 'GITHUB_TARGET_CONFIGURED: origin·저장소·기준 브랜치가 일치합니다.'
Write-Host "repository=$targetRepository baseBranch=$($BaseBranch.Trim())"
Write-Host 'guardrail=commit·push·PR·배포는 자동 실행하지 않았습니다.'
Write-Host $preflight

