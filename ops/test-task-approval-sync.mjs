import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncTaskApproval } from './task-approval-sync.mjs';

const root = await mkdtemp(join(tmpdir(), 'raw-material-task-approval-'));
try {
  const queuePath = join(root, 'task-queue.json');
  const auditPath = join(root, 'task-approval-sync.jsonl');
  await writeFile(queuePath, `${JSON.stringify({ tasks: [{ id: 'TASK-1', status: 'review', nextAction: '검토' }, { id: 'TASK-DONE', status: 'done' }] })}\n`);

  const approved = await syncTaskApproval({ queuePath, auditPath, approvalId: 'APPROVAL-1', taskId: 'TASK-1', decision: 'approve', decidedBy: 'H-01', decidedAt: '2026-09-15T00:00:00.000Z', note: 'Shadow Pilot 범위 승인' });
  assert.equal(approved.currentStatus, 'approved');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  assert.equal(queue.tasks.find((task) => task.id === 'TASK-1').status, 'approved');
  assert.equal(queue.tasks.find((task) => task.id === 'TASK-1').reviewedAt, '2026-09-15T00:00:00.000Z');

  const retry = await syncTaskApproval({ queuePath, auditPath, approvalId: 'APPROVAL-1', taskId: 'TASK-1', decision: 'approve', decidedBy: 'H-01', decidedAt: '2026-09-15T00:00:00.000Z' });
  assert.equal(retry.idempotent, true);
  assert.equal((await readFile(auditPath, 'utf8')).trim().split(/\r?\n/).length, 1);

  const held = await syncTaskApproval({ queuePath, auditPath, approvalId: 'APPROVAL-2', taskId: 'TASK-1', decision: 'hold', decidedBy: 'H-01', decidedAt: '2026-09-15T00:01:00.000Z' });
  assert.equal(held.currentStatus, 'review');
  await assert.rejects(() => syncTaskApproval({ queuePath, auditPath, approvalId: 'APPROVAL-3', taskId: 'TASK-DONE', decision: 'request_changes', decidedBy: 'H-01' }), { code: 'TASK_ALREADY_TERMINAL' });
  const missing = await syncTaskApproval({ queuePath, auditPath, approvalId: 'APPROVAL-MISSING', taskId: 'TASK-MISSING', decision: 'approve', decidedBy: 'H-01' });
  assert.equal(missing.status, 'TASK_NOT_FOUND');
  await assert.rejects(() => syncTaskApproval({ queuePath, auditPath, taskId: 'TASK-1', decision: 'invalid', decidedBy: 'H-01' }), { code: 'TASK_APPROVAL_DECISION_INVALID' });
  console.log('task approval sync tests: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}

