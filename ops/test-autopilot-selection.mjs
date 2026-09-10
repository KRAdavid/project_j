import assert from 'node:assert/strict';
import { evidenceFingerprint, selectNextTask } from './autopilot-selection.mjs';

const evidence = [{ name: 'postgres', passed: true, skipped: true, output: 'DATABASE_URL missing' }];
const fingerprint = evidenceFingerprint(evidence);
assert.equal(
  evidenceFingerprint([{ name: 'preflight', passed: true, skipped: false, output: '{"checkedAt":"2026-09-09T10:00:00.000Z","status":"BLOCKED"}' }]),
  evidenceFingerprint([{ name: 'preflight', passed: true, skipped: false, output: '{"checkedAt":"2026-09-09T11:00:00.000Z","status":"BLOCKED"}' }]),
);
assert.notEqual(
  evidenceFingerprint([{ name: 'preflight', passed: true, skipped: false, output: '{"status":"BLOCKED"}' }]),
  evidenceFingerprint([{ name: 'preflight', passed: true, skipped: false, output: '{"status":"OK"}' }]),
);
const tasks = [
  { id: 'TASK-WORKING-OLD', status: 'working', risk: 'critical' },
  { id: 'TASK-WORKING-NEW', status: 'working', risk: 'high' },
  { id: 'TASK-QUEUED', status: 'queued', risk: 'low' },
];

let selected = selectNextTask({
  tasks,
  packetRecords: new Map([
    ['TASK-WORKING-OLD', { packetCount: 12, generatedAt: '2026-09-09T10:00:00.000Z', evidenceFingerprint: fingerprint }],
  ]),
  pendingApprovalTaskIds: new Set(['TASK-WORKING-OLD']),
  currentEvidenceFingerprint: fingerprint,
});
assert.equal(selected.task.id, 'TASK-QUEUED');
assert.equal(selected.selectionType, 'queued');

selected = selectNextTask({
  tasks: tasks.filter((task) => task.id !== 'TASK-QUEUED'),
  packetRecords: new Map([
    ['TASK-WORKING-OLD', { packetCount: 12, generatedAt: '2026-09-09T10:00:00.000Z', evidenceFingerprint: fingerprint }],
  ]),
  pendingApprovalTaskIds: new Set(['TASK-WORKING-OLD']),
  currentEvidenceFingerprint: fingerprint,
});
assert.equal(selected.task.id, 'TASK-WORKING-NEW');

selected = selectNextTask({
  tasks: tasks.filter((task) => task.id !== 'TASK-QUEUED'),
  packetRecords: new Map([
    ['TASK-WORKING-OLD', { packetCount: 12, generatedAt: '2026-09-09T10:00:00.000Z', evidenceFingerprint: fingerprint }],
    ['TASK-WORKING-NEW', { packetCount: 1, generatedAt: '2026-09-09T10:01:00.000Z', evidenceFingerprint: fingerprint }],
  ]),
  pendingApprovalTaskIds: new Set(['TASK-WORKING-OLD', 'TASK-WORKING-NEW']),
  currentEvidenceFingerprint: 'changed-evidence',
});
assert.equal(selected.task.id, 'TASK-WORKING-NEW');

selected = selectNextTask({
  tasks: tasks.filter((task) => task.id !== 'TASK-QUEUED'),
  packetRecords: new Map([
    ['TASK-WORKING-OLD', { packetCount: 12, generatedAt: '2026-09-09T10:00:00.000Z', evidenceFingerprint: fingerprint }],
    ['TASK-WORKING-NEW', { packetCount: 1, generatedAt: '2026-09-09T10:01:00.000Z', evidenceFingerprint: fingerprint }],
  ]),
  pendingApprovalTaskIds: new Set(['TASK-WORKING-OLD', 'TASK-WORKING-NEW']),
  currentEvidenceFingerprint: fingerprint,
});
assert.equal(selected.task, null);
assert.equal(selected.selectionType, 'none');
console.log('autopilot selection tests: PASS');

