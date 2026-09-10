import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = await readFile(resolve(root, 'ops', 'configure-github-target.ps1'), 'utf8');

const assertions = [
  ['requires an explicit repository URL, repository name, and base branch', source.includes('[string]$RepositoryUrl') && source.includes('[string]$Repository') && source.includes('[string]$BaseBranch')],
  ['accepts HTTPS and SCP-style SSH GitHub URLs only', source.includes('GITHUB_TARGET_URL_INVALID') && source.includes('GITHUB_TARGET_HOST_INVALID') && source.includes('git@github\\.com:')],
  ['does not overwrite a non-GitHub or mismatched origin by default', source.includes('GITHUB_ORIGIN_INVALID') && source.includes('GITHUB_ORIGIN_MISMATCH') && source.includes('-ReplaceOrigin')],
  ['verifies the configured origin before external work', source.includes('GITHUB_TARGET_VERIFY_FAILED') && source.includes('remote get-url origin')],
  ['persists only non-secret target metadata for later audits', source.includes('github-target.json') && source.includes('externalWritesPerformed = $false')],
  ['runs strict target preflight', source.includes('github-target-preflight.mjs') && source.includes('--strict')],
  ['does not commit, push, create PRs, or deploy', source.includes('commit·push·PR·배포는 자동 실행하지 않았습니다.')],
];

const failures = assertions.filter(([, passed]) => !passed);
if (failures.length) {
  console.error(failures.map(([name]) => `FAIL: ${name}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`GitHub target config contract: PASS (${assertions.length})`);
}

