import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decideApproval } from './approval-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'raw-material-approval-'));
const inboxPath = join(root, 'approval-inbox.json');
const logPath = join(root, 'approval-decisions.jsonl');
await writeFile(inboxPath, `${JSON.stringify({ schemaVersion: 'APPROVAL-INBOX-0.1', status: 'PENDING', items: [{ approvalId: 'APPROVAL-001', status: 'PENDING', taskId: 'TASK-001', sourceRunId: 'RUN-001' }] })}\n`);
const result = await decideApproval(inboxPath, logPath, 'APPROVAL-001', { decision: 'hold', decidedBy: 'H-01', note: '추가 증거 확인' });
assert.equal(result.item.status, 'HELD');
assert.equal(result.inbox.status, 'CLEAR');
assert.equal(JSON.parse(await readFile(inboxPath, 'utf8')).items[0].decisionNote, '추가 증거 확인');
assert.equal((await readFile(logPath, 'utf8')).trim().split(/\r?\n/).length, 1);
const idempotent = await decideApproval(inboxPath, logPath, 'APPROVAL-001', { decision: 'hold', decidedBy: 'H-01' });
assert.equal(idempotent.idempotent, true);
await assert.rejects(() => decideApproval(inboxPath, logPath, 'APPROVAL-001', { decision: 'approve', decidedBy: 'H-01' }), (error) => error.code === 'APPROVAL_ALREADY_DECIDED');
console.log('approval store tests: PASS');

