import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

const repositoryFromRemote = (remote = '') => {
  const value = String(remote || '').trim().replace(/\.git$/, '');
  const match = value.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i);
  return match ? match[1] : '';
};

export const buildGitHubTargetPreflight = ({ repository = '', remote = '', baseBranch = '' } = {}) => {
  const target = String(repository || '').trim();
  const remoteRepository = repositoryFromRemote(remote);
  const checks = [
    { id: 'TARGET_REPOSITORY', ready: REPOSITORY_PATTERN.test(target), evidence: 'GITHUB_REPOSITORY owner/name' },
    { id: 'ORIGIN_REMOTE', ready: Boolean(remoteRepository), evidence: 'git remote origin' },
    { id: 'TARGET_REMOTE_MATCH', ready: Boolean(target && remoteRepository && target.toLowerCase() === remoteRepository.toLowerCase()), evidence: 'repository equals origin' },
    { id: 'BASE_BRANCH_DECLARED', ready: Boolean(String(baseBranch || '').trim()), evidence: 'GITHUB_BASE_BRANCH' },
  ];
  const missing = checks.filter((check) => !check.ready).map((check) => check.id);
  return {
    schemaVersion: 'GITHUB-TARGET-PREFLIGHT-0.1',
    status: missing.length ? 'BLOCKED' : 'TARGET_MATCH',
    targetRepository: target || null,
    remoteRepository: remoteRepository || null,
    baseBranch: String(baseBranch || '').trim() || null,
    checks,
    missing,
    secretValuesRedacted: true,
    stopRule: '저장소·origin·기준 브랜치가 일치하지 않으면 외부 GitHub 쓰기·커밋·PR 생성을 시작하지 않는다.',
  };
};

const gitOrigin = () => {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : '';
};

const readTargetConfig = () => {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('./github-target.json', import.meta.url)), 'utf8').replace(/^\uFEFF/, '')); }
  catch { return {}; }
};

if (process.argv[1] && basename(process.argv[1]) === 'github-target-preflight.mjs') {
  const configured = readTargetConfig();
  const result = buildGitHubTargetPreflight({
    repository: process.env.GITHUB_REPOSITORY || configured.repository,
    remote: gitOrigin(),
    baseBranch: process.env.GITHUB_BASE_BRANCH || configured.baseBranch,
  });

  console.log(JSON.stringify({ ...result, checkedAt: new Date().toISOString() }));
  if (process.argv.includes('--strict') && result.status !== 'TARGET_MATCH') process.exitCode = 2;
}

