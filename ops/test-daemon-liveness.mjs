import assert from 'node:assert/strict';
import { evaluateDaemonLiveness } from './daemon-liveness.mjs';

const now = Date.parse('2026-09-09T13:30:00.000Z');
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', updatedAt: '2026-09-09T13:20:00.000Z', pid: 123 }, { now, maxAgeMs: 20 * 60 * 1000 }).ready, true);
assert.equal(evaluateDaemonLiveness({ status: 'STOPPING', updatedAt: '2026-09-09T13:29:00.000Z' }, { now }).reason, 'DAEMON_NOT_LIVE');
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-09T12:00:00.000Z' }, { now }).reason, 'DAEMON_STATUS_STALE');
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-09T13:29:00.000Z', lastCycle: 1, lastCycleExitCode: 1 }, { now }).reason, 'DAEMON_LAST_CYCLE_FAILED');
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-09T13:29:00.000Z', lastCycle: 1, lastCycleExitCode: 1, lastCycleDecision: 'INCIDENT_HUMAN_REVIEW_REQUIRED' }, { now }).reason, 'DAEMON_CYCLE_REQUIRES_HUMAN_REVIEW');
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-09T13:29:00.000Z', lastCycle: 1, lastCycleExitCode: 1, lastCycleDecision: 'HUMAN_REVIEW_REQUIRED' }, { now }).cycleNeedsHumanReview, true);
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-09T13:29:00.000Z', lastCycle: 1, lastCycleExitCode: 0, lastCycleTimedOut: true }, { now }).reason, 'DAEMON_LAST_CYCLE_TIMED_OUT');
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', pid: 123, updatedAt: '2026-09-09T13:29:00.000Z', lastCycle: 1, lastCycleExitCode: 0 }, { now, processAlive: false }).reason, 'DAEMON_PROCESS_NOT_ALIVE');
assert.equal(evaluateDaemonLiveness({ status: 'WAITING', updatedAt: '2026-09-09T13:29:00.000Z', lastCycle: 1, lastCycleExitCode: 0 }, { now }).reason, 'DAEMON_PROCESS_NOT_ALIVE');
assert.equal(evaluateDaemonLiveness({}, { now }).reason, 'DAEMON_NOT_LIVE');
console.log('daemon liveness tests: PASS');

