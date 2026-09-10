import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTriggerTasks, deriveOperationalSignals, deriveTaskMetadataSignals, enqueueTriggerTasks, reconcileTriggerQueue, selectActiveTriggerTasks, upsertTriggerInbox } from './trigger-engine.mjs';
import { parseOperationalTimestamp } from './operational-time.mjs';

const signals = deriveOperationalSignals({
  evidence: [
    { name: 'postgres-integration', passed: true, skipped: true, output: 'DATABASE_URL not provided' },
    { name: 'transaction-integrity', passed: false, skipped: false, output: 'assertion failed' },
  ],
  readiness: { decision: 'NO_GO', missing: ['R-01', 'R-06'] },
});
assert.equal(signals.length, 3);
assert.equal(signals.filter((signal) => signal.triggerKey === 'EVIDENCE_GAP').length, 1);
assert.equal(signals.filter((signal) => signal.triggerKey === 'QUALITY_GATE_FAILED').length, 1);
const tasks = buildTriggerTasks({ signals, generatedAt: '2026-09-08T00:00:00.000Z' });
assert.equal(tasks.every((task) => task.humanGate === 'approval' && task.status === 'queued'), true);
assert.equal(tasks.find((task) => task.triggerKey === 'EVIDENCE_GAP').ownerAi, 'AI-10 아틀라스');
assert.equal(tasks.some((task) => task.ownerAi === 'AI-01 세온'), true);

const metadataSignals = deriveTaskMetadataSignals({
  taskQueue: {
    tasks: [
      { id: 'TASK-A', status: 'working', createdAt: null, claimedAt: null },
      { id: 'TASK-B', status: 'review', createdAt: '2026-09-08T00:00:00.000Z', claimedAt: null },
      { id: 'TASK-C', status: 'queued', createdAt: '2026-09-08T00:00:00.000Z' },
      { id: 'TASK-D', status: 'done', createdAt: null, claimedAt: null },
    ],
  },
});
assert.equal(metadataSignals.length, 1);
assert.equal(metadataSignals[0].triggerKey, 'TASK_METADATA_GAP');
assert.match(metadataSignals[0].context, /TASK-A/);
assert.match(metadataSignals[0].context, /TASK-B/);

const root = await mkdtemp(join(tmpdir(), 'raw-material-trigger-'));
const inboxPath = join(root, 'trigger-inbox.json');
const queuePath = join(root, 'task-queue.json');
await import('node:fs/promises').then(({ writeFile }) => writeFile(queuePath, JSON.stringify({ tasks: [] })));
const first = await upsertTriggerInbox(inboxPath, tasks, { generatedAt: '2026-09-08T00:00:00.000Z' });
assert.equal(first.additions.length, 3);
const second = await upsertTriggerInbox(inboxPath, tasks, { generatedAt: '2026-09-08T00:01:00.000Z' });
assert.equal(second.additions.length, 0);
assert.equal(JSON.parse(await readFile(inboxPath, 'utf8')).pending, 3);
const third = await upsertTriggerInbox(inboxPath, tasks.filter((task) => task.triggerKey !== 'QUALITY_GATE_FAILED'), { generatedAt: '2026-09-08T00:02:00.000Z' });
const revalidatedQualityTask = JSON.parse(await readFile(inboxPath, 'utf8')).tasks.find((task) => task.triggerKey === 'QUALITY_GATE_FAILED');
assert.equal(revalidatedQualityTask.lastRecheckResult, 'NOT_DETECTED');
assert.equal(third.inbox.pending, 2);
assert.equal(third.inbox.auditOnlyPending, 1);
assert.equal(third.inbox.status, 'PENDING');
const activeAfterClear = selectActiveTriggerTasks({ currentTasks: tasks.filter((task) => task.triggerKey !== 'QUALITY_GATE_FAILED'), inbox: JSON.parse(await readFile(inboxPath, 'utf8')) });
assert.equal(activeAfterClear.length, 2);
assert.equal(activeAfterClear.some((task) => task.triggerKey === 'QUALITY_GATE_FAILED'), false);
const enqueued = await enqueueTriggerTasks(queuePath, tasks, { generatedAt: '2026-09-08T00:03:00.000Z' });
assert.equal(enqueued.additions.length, 3);
for (const task of enqueued.additions) {
  assert.equal(task.createdAt, '2026-09-08T00:00:00.000Z');
  assert.equal(task.enqueuedAt, '2026-09-08T00:03:00.000Z');
  assert.equal(task.updatedAt, '2026-09-08T00:03:00.000Z');
}
const deduped = await enqueueTriggerTasks(queuePath, tasks, { generatedAt: '2026-09-08T00:04:00.000Z' });
assert.equal(deduped.additions.length, 0);
const reconciled = await reconcileTriggerQueue(queuePath, new Set([tasks[0].fingerprint]), { generatedAt: '2026-09-08T00:05:00.000Z' });
assert.equal(reconciled.resolvedTaskIds.length, 2);
assert.equal(reconciled.queue.tasks.filter((task) => task.status === 'resolved').length, 2);
assert.equal(reconciled.queue.tasks.find((task) => task.fingerprint === tasks[0].fingerprint).status, 'queued');
const futureTaskQueuePath = join(root, 'future-task-queue.json');
await import('node:fs/promises').then(({ writeFile }) => writeFile(futureTaskQueuePath, JSON.stringify({ tasks: [{ ...tasks[1], triggerTask: true, triggerFingerprint: tasks[1].fingerprint, status: 'queued', createdAt: '2026-09-08T00:10:00.000Z' }] })));
const futureResolved = await reconcileTriggerQueue(futureTaskQueuePath, new Set(), { generatedAt: '2026-09-08T00:05:00.000Z' });
const futureTask = futureResolved.queue.tasks[0];
if (!(parseOperationalTimestamp(futureTask.resolvedAt) > parseOperationalTimestamp(futureTask.createdAt)) || !(parseOperationalTimestamp(futureTask.updatedAt) >= parseOperationalTimestamp(futureTask.resolvedAt))) throw new Error('업무 수명주기 시간 역전 방지 실패');
const allCleared = await upsertTriggerInbox(inboxPath, [], { generatedAt: '2026-09-08T00:06:00.000Z' });
assert.equal(allCleared.inbox.pending, 0);
assert.equal(allCleared.inbox.auditOnlyPending, 3);
assert.equal(allCleared.inbox.status, 'AUDIT_ONLY');
console.log('trigger engine tests: PASS');

