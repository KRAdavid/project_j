import assert from 'node:assert/strict';
import { buildGitHubTargetPreflight } from './github-target-preflight.mjs';

const blocked = buildGitHubTargetPreflight({ repository: '', remote: '', baseBranch: '' });
assert.equal(blocked.status, 'BLOCKED');
assert.deepEqual(blocked.missing, ['TARGET_REPOSITORY', 'ORIGIN_REMOTE', 'TARGET_REMOTE_MATCH', 'BASE_BRANCH_DECLARED']);
assert.equal(blocked.secretValuesRedacted, true);

const matched = buildGitHubTargetPreflight({
  repository: 'KRAdavid/raw-material-os',
  remote: 'https://github.com/KRAdavid/raw-material-os.git',
  baseBranch: 'main',
});
assert.equal(matched.status, 'TARGET_MATCH');
assert.deepEqual(matched.missing, []);
assert.equal(matched.remoteRepository, 'KRAdavid/raw-material-os');

const mismatch = buildGitHubTargetPreflight({
  repository: 'KRAdavid/raw-material-os',
  remote: 'git@github.com:KRAdavid/gaba-feed-business-index.git',
  baseBranch: 'main',
});
assert.equal(mismatch.status, 'BLOCKED');
assert.ok(mismatch.missing.includes('TARGET_REMOTE_MATCH'));
console.log('github target preflight tests: PASS');

