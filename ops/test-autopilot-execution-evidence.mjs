import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { recordAutopilotExecution } from './autopilot-execution-evidence.mjs';

const root = await mkdtemp(resolve(tmpdir(), 'raw-material-autopilot-evidence-'));
const queuePath = resolve(root, 'task-queue.json');
const auditPath = resolve(root, 'autopilot-execution-evidence.jsonl');
const generatedAt = '2026-09-12T07:00:00.000Z';

await import('node:fs/promises').then(({ writeFile }) => writeFile(queuePath, `${JSON.stringify({ tasks: [
  { id: 'TASK-WORKING', status: 'working', claimedAt: '2026-09-12T06:00:00.000Z', updatedAt: '2026-09-12T06:00:00.000Z' },
  { id: 'TASK-REVIEW-READY', status: 'working', evidence: ['existing-evidence.json'], updatedAt: '2026-09-12T06:00:00.000Z' },
  { id: 'TASK-QUEUED', status: 'queued', updatedAt: '2026-09-12T06:00:00.000Z' },
] }, null, 2)}\n`, 'utf8'));

const recorded = await recordAutopilotExecution({
  queuePath,
  auditPath,
  selectedTaskId: 'TASK-WORKING',
  runId: 'AUTOPILOT-TEST-001',
  generatedAt,
  decision: 'HUMAN_REVIEW_REQUIRED',
});
assert.equal(recorded.status, 'RECORDED');
const queueAfter = JSON.parse(await readFile(queuePath, 'utf8'));
const working = queueAfter.tasks.find((task) => task.id === 'TASK-WORKING');
assert.equal(working.lastRecheckedAt, generatedAt);
assert.equal(working.lastRecheckResult, 'AUTOPILOT_HUMAN_REVIEW_REQUIRED');
assert.equal(working.updatedAt, generatedAt);
assert.equal(working.claimedAt, '2026-09-12T06:00:00.000Z');
assert.equal((await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).length, 1);

const reviewReady = await recordAutopilotExecution({
  queuePath,
  auditPath,
  selectedTaskId: 'TASK-REVIEW-READY',
  runId: 'AUTOPILOT-TEST-REVIEW-READY',
  generatedAt,
  decision: 'HUMAN_REVIEW_REQUIRED',
  reviewReady: true,
  reviewEvidenceRefs: ['ops/latest-shadow-pilot.json'],
  reviewReadyReason: '폐쇄형 Shadow Pilot 통과',
});
assert.equal(reviewReady.status, 'RECORDED');
const queueAfterReviewReady = JSON.parse(await readFile(queuePath, 'utf8'));
const reviewTask = queueAfterReviewReady.tasks.find((task) => task.id === 'TASK-REVIEW-READY');
assert.equal(reviewTask.status, 'review');
assert.equal(reviewTask.lastRecheckResult, 'AUTOPILOT_REVIEW_READY');
assert.deepEqual(reviewTask.evidence, ['existing-evidence.json', 'ops/latest-shadow-pilot.json']);
assert.equal(reviewTask.reviewedAt, undefined, 'AI는 H-01 검토 완료 시각을 기록하면 안 됩니다.');
assert.equal((await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).length, 2);

const notClaimed = await recordAutopilotExecution({
  queuePath,
  auditPath,
  selectedTaskId: 'TASK-QUEUED',
  runId: 'AUTOPILOT-TEST-002',
  generatedAt,
  decision: 'HUMAN_REVIEW_REQUIRED',
});
assert.equal(notClaimed.status, 'WAITING_FOR_CLAIM');
const queueAfterNoClaim = JSON.parse(await readFile(queuePath, 'utf8'));
assert.equal(queueAfterNoClaim.tasks.find((task) => task.id === 'TASK-QUEUED').lastRecheckedAt, undefined);

console.log(JSON.stringify({ status: 'PASS', recorded: recorded.status, queuedGuard: notClaimed.status }));

