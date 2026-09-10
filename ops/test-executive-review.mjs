import assert from 'node:assert/strict';
import { buildExecutiveReview } from './executive-review.mjs';

const review = buildExecutiveReview({
  generatedAt: '2026-09-09T00:00:00.000Z',
  cycle: { cycleId: 'OPS-TEST', monitor: { status: 'OK' }, autopilot: { taskId: 'TASK-TEST' }, automation: { notificationOutbox: { dispatch: { status: 'OUTBOX_ONLY', externalNotificationSent: false, incidentEscalation: false } }, taskTimelineAudit: { status: 'ACTIVE_TIMELINE_INVALID', activeViolationCount: 1, archiveViolationCount: 2, remainingArchiveViolationCount: 0 }, taskAuditRemediation: { status: 'WAITING_FOR_H01_APPROVAL', planId: 'PLAN-1', actionCount: 1, eligibleActionCount: 1, requiredApprovalId: 'APPROVAL-1' } } },
  autopilot: {
    decision: 'HUMAN_REVIEW_REQUIRED',
    selectedTask: { id: 'TASK-TEST' },
    evidence: [
      { name: 'pass', passed: true, skipped: false },
      { name: 'staging-preflight', passed: true, skipped: false, output: '{"status":"BLOCKED","missing":["DATABASE_URL"],"secretValuesRedacted":true}' },
      { name: 'github-target-preflight', passed: true, skipped: false, output: '{"status":"BLOCKED","missing":["TARGET_REPOSITORY"],"secretValuesRedacted":true}' },
      { name: 'postgres', passed: true, skipped: true, output: 'SKIP' },
    ],
  },
  readiness: { decision: 'NO_GO', missing: ['R-01', 'R-07'] },
  approvalInbox: { status: 'PENDING', items: [{ status: 'PENDING' }, { status: 'HELD' }] },
  taskQueue: { tasks: [{ id: 'T-1', status: 'working', risk: 'critical', createdAt: '2026-09-06T00:00:00.000Z', claimedAt: '2026-09-07T00:00:00.000Z' }] },
});
assert.equal(review.decision, 'HOLD');
assert.equal(review.recommendation, 'HOLD_REAL_OPERATIONS');
assert.equal(review.readiness.requiredActions.length, 2);
assert.equal(review.evidence.skipped.length, 1);
assert.equal(review.stagingPreflight.missing[0], 'DATABASE_URL');
assert.equal(review.githubTargetPreflight.missing[0], 'TARGET_REPOSITORY');
assert.equal(review.approvals.pending, 1);
assert.equal(review.approvals.sla.pendingCount, 1);
assert.equal(review.approvals.decisionGuide.length, 1);
assert.equal(review.approvals.decisionGuide[0].humanPrincipal, 'H-01');
assert.equal(review.approvals.decisionGuide[0].externalSideEffect, false);
assert.equal(review.approvals.decisionGuide[0].recommendation, 'HOLD_REAL_OPERATIONS');
assert.equal(review.tasks.sla.staleCount, 1);
assert.equal(review.notifications.delivery, 'OUTBOX_ONLY');
assert.equal(review.notifications.externalNotificationSent, false);
assert.equal(review.taskAudit.status, 'ACTIVE_TIMELINE_INVALID');
assert.equal(review.taskAudit.remediationStatus, 'WAITING_FOR_H01_APPROVAL');
assert.equal(review.taskAudit.eligibleActionCount, 1);
assert.equal(review.options.find((option) => option.recommended).id, 'HOLD_REAL_OPERATIONS');
const currentTargetReview = buildExecutiveReview({
  autopilot: { evidence: [{ name: 'github-target-preflight', passed: true, output: '{"status":"NOT_AVAILABLE"}' }] },
  githubTargetPreflight: { status: 'TARGET_MATCH', missing: [], secretValuesRedacted: true },
});
assert.equal(currentTargetReview.githubTargetPreflight.status, 'TARGET_MATCH');
console.log('executive review tests: PASS');

