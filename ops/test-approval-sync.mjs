import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeTriggerApprovalItems } from './autopilot-ledger.mjs';

const root = await mkdtemp(join(tmpdir(), 'raw-material-approval-sync-'));
const inboxPath = join(root, 'approval-inbox.json');
await writeFile(inboxPath, `${JSON.stringify({ schemaVersion: 'APPROVAL-INBOX-0.1', status: 'PENDING', items: [{ approvalId: 'APPROVAL-EXISTING', status: 'PENDING', taskId: 'TASK-EXISTING' }] })}\n`);
const triggerTasks = [
  { id: 'TASK-EXISTING', objective: 'existing', risk: 'critical', reviewers: ['AI-11'] },
  { id: 'AUTO-NEW', triggerKey: 'EVIDENCE_GAP', objective: 'new', risk: 'critical', reviewers: ['AI-07'] },
];
const first = await mergeTriggerApprovalItems(inboxPath, triggerTasks, { sourceRunId: 'RUN-001' });
assert.equal(first.additions.length, 1);
assert.equal(first.inbox.items.length, 2);
const second = await mergeTriggerApprovalItems(inboxPath, triggerTasks, { sourceRunId: 'RUN-002' });
assert.equal(second.additions.length, 0);
assert.equal(JSON.parse(await readFile(inboxPath, 'utf8')).items.length, 2);
console.log('approval sync tests: PASS');

