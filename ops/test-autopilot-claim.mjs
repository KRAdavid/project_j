import assert from 'node:assert/strict';
import { claimQueuedTask } from './autopilot-claim.mjs';

const queued = { id: 'TASK-TEST-001', status: 'queued' };
const claimed = claimQueuedTask(queued, 'queued', { claimedAt: '2026-09-09T00:00:00.000Z', claimedBy: 'AI-10 아틀라스' });
assert.equal(claimed.claimed, true);
assert.equal(queued.status, 'working');
assert.equal(queued.claimedBy, 'AI-10 아틀라스');
assert.equal(queued.claimedAt, '2026-09-09T00:00:00.000Z');
assert.equal(queued.updatedAt, '2026-09-09T00:00:00.000Z');

for (const [task, selectionType] of [
  [{ id: 'TASK-TEST-002', status: 'working' }, 'working-follow-up'],
  [{ id: 'TASK-TEST-003', status: 'review' }, 'human-review'],
  [null, 'none'],
]) {
  const before = task && { ...task };
  const result = claimQueuedTask(task, selectionType, { claimedAt: '2026-09-09T00:00:00.000Z' });
  assert.equal(result.claimed, false);
  assert.deepEqual(task, before);
}

assert.throws(() => claimQueuedTask({ status: 'queued' }, 'queued'), /인수 시각/);
assert.throws(() => claimQueuedTask({ status: 'queued' }, 'queued', { claimedAt: 'not-a-time' }), /인수 시각 형식/);
console.log('autopilot claim tests: PASS');

