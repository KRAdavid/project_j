import assert from 'node:assert/strict';
import { isProcessAlive, projectRuntimeLiveness } from './runtime-liveness.mjs';

assert.equal(isProcessAlive(123, () => {}), true);
assert.equal(isProcessAlive(123, () => { throw new Error('missing'); }), false);
assert.equal(isProcessAlive(0, () => {}), false);

const now = Date.parse('2026-09-15T00:00:00.000Z');
const live = projectRuntimeLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-14T23:55:00.000Z', lastCycle: 1, lastCycleExitCode: 0 }, { now, maxAgeMs: 20 * 60 * 1000, processAlive: true });
assert.equal(live.status, 'WAITING');
assert.equal(live.reportedStatus, 'WAITING');
assert.equal(live.liveness.ready, true);

const stale = projectRuntimeLiveness({ status: 'RUNNING', pid: 123, updatedAt: '2026-09-14T23:55:00.000Z' }, { now, maxAgeMs: 2 * 60 * 1000, processAlive: false });
assert.equal(stale.status, 'STALE');
assert.equal(stale.reportedStatus, 'RUNNING');
assert.equal(stale.liveness.reason, 'DAEMON_PROCESS_NOT_ALIVE');

const review = projectRuntimeLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-14T23:59:00.000Z', lastCycle: 1, lastCycleExitCode: 1, lastCycleDecision: 'HUMAN_REVIEW_REQUIRED' }, { now, processAlive: true });
assert.equal(review.status, 'REVIEW_REQUIRED');
assert.equal(review.liveness.cycleNeedsHumanReview, true);

console.log('runtime liveness tests: PASS');

