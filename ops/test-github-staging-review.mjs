import assert from 'node:assert/strict';
import { buildStagingReview, parseGitStatus } from './github-staging-review.mjs';

const entries = parseGitStatus('M  README.md\0 M beta-app/app.js\0?? ops/new-file.mjs\0A  .github/workflows/quality-gates.yml\0');
assert.equal(entries.length, 4);
assert.equal(entries[0].status, 'M ');
assert.equal(entries[2].status, '??');
const review = buildStagingReview({ entries, generatedAt: '2026-09-10T00:00:00.000Z' });
assert.equal(review.status, 'REVIEW_REQUIRED');
assert.equal(review.totalFiles, 4);
assert.equal(review.stagedFiles, 2);
assert.equal(review.unstagedFiles, 1);
assert.equal(review.untrackedFiles, 1);
assert.ok(review.groups.some((group) => group.category === 'github-governance'));
console.log('GitHub staging review tests: PASS');

