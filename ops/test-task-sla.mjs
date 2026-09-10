import assert from 'node:assert/strict';
import { evaluateTaskSla } from './task-sla.mjs';
import { deriveTaskSlaSignals } from './trigger-engine.mjs';

const now = '2026-09-10T12:00:00.000Z';
const result = evaluateTaskSla({
  now,
  tasks: [
    { id: 'T-CRITICAL', status: 'working', risk: 'critical', createdAt: '2026-09-07T00:00:00.000Z', claimedAt: '2026-09-08T00:00:00.000Z', ownerAi: 'AI-10 아틀라스' },
    { id: 'T-REVIEW', status: 'review', risk: 'high', createdAt: '2026-09-09T00:00:00.000Z', claimedAt: '2026-09-09T12:00:00.000Z', ownerAi: 'AI-07 큐비' },
    { id: 'T-QUEUED', status: 'queued', risk: 'high', createdAt: '2026-09-10T00:00:00.000Z' },
    { id: 'T-MISSING', status: 'working', risk: 'critical', createdAt: '2026-09-07T00:00:00.000Z' },
  ],
});
assert.equal(result.activeCount, 4);
assert.equal(result.metadataCompleteCount, 3);
assert.equal(result.staleCount, 1);
assert.equal(result.status, 'STALE_TASKS');
assert.equal(result.items.find((item) => item.taskId === 'T-CRITICAL').action, 'ESCALATE_AI01_AND_H01');
assert.equal(result.items.find((item) => item.taskId === 'T-MISSING').metadataComplete, false);

const signals = deriveTaskSlaSignals({
  now,
  taskQueue: { tasks: result.items.map((item) => ({ ...item, id: item.taskId })) },
});
assert.equal(signals.length, 1);
assert.equal(signals[0].triggerKey, 'TASK_SLA_BREACH');
assert.match(signals[0].context, /T-CRITICAL/);

const clear = deriveTaskSlaSignals({ now, taskQueue: { tasks: [{ id: 'T-OK', status: 'queued', risk: 'high', createdAt: '2026-09-10T00:00:00.000Z' }] } });
assert.equal(clear.length, 0);
console.log('task SLA tests: PASS');

