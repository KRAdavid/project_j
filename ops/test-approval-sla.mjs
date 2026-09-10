import assert from 'node:assert/strict';
import { evaluateApprovalSla } from './approval-sla.mjs';

const result = evaluateApprovalSla({
  now: '2026-09-09T12:00:00.000Z',
  items: [
    { approvalId: 'A-1', taskId: 'T-1', risk: 'critical', status: 'PENDING', createdAt: '2026-09-08T10:00:00.000Z' },
    { approvalId: 'A-2', taskId: 'T-2', risk: 'high', status: 'PENDING', createdAt: '2026-09-09T00:00:00.000Z' },
    { approvalId: 'A-3', taskId: 'T-3', risk: 'critical', status: 'APPROVED', createdAt: '2026-09-07T00:00:00.000Z' },
  ],
});
assert.equal(result.pendingCount, 2);
assert.equal(result.staleCount, 1);
assert.equal(result.status, 'STALE_APPROVALS');
assert.equal(result.items[0].action, 'ESCALATE_H01_REVIEW');
assert.equal(result.items[1].action, 'WAIT_WITHIN_SLA');
assert.equal(result.externalNotificationSent, false);
console.log('approval SLA tests: PASS');

