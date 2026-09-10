import assert from 'node:assert/strict';
import { buildGitHubPublicationPreflight } from './github-publication-preflight.mjs';

const files = [
  '.gitattributes',
  '.github/workflows/quality-gates.yml',
  '.github/workflows/production-cutover-gate.yml',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'beta-app/server.mjs',
  'data/material-master.json',
  'data/postgres-schema.sql',
  'ops/github-target.json',
];
const blocked = await buildGitHubPublicationPreflight({ target: { repository: 'KRAdavid/project_j', baseBranch: 'main' }, localBranch: 'master', files, stagedFiles: files, unstagedFiles: [], untrackedFiles: [] });
assert.equal(blocked.status, 'BLOCKED');
assert.ok(blocked.blockers.includes('LOCAL_BRANCH_DIFFERS_FROM_TARGET_BASE'));
const worktreeBlocked = await buildGitHubPublicationPreflight({ target: { repository: 'KRAdavid/project_j', baseBranch: 'main' }, localBranch: 'main', files, stagedFiles: files, unstagedFiles: ['README.md'], untrackedFiles: [] });
assert.ok(worktreeBlocked.blockers.includes('WORKTREE_NOT_STAGED_FOR_EXPLICIT_COMMIT'));
const ready = await buildGitHubPublicationPreflight({ target: { repository: 'KRAdavid/project_j', baseBranch: 'main' }, localBranch: 'main', files, stagedFiles: files, unstagedFiles: [], untrackedFiles: [] });
assert.ok(!ready.blockers.includes('LOCAL_BRANCH_DIFFERS_FROM_TARGET_BASE'));
assert.equal(ready.externalWritesPerformed, false);
console.log('GitHub publication preflight tests: PASS');

