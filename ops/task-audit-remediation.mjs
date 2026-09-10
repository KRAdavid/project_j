import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { parseOperationalTimestamp } from './operational-time.mjs';

const PLAN_SCHEMA = 'TASK-AUDIT-REMEDIATION-PLAN-0.1';
const LOG_SCHEMA = 'TASK-AUDIT-REMEDIATION-0.1';
const H01 = 'H-01';
const APPROVAL_ID = 'APPROVAL-TRIGGER-AUTO-QUALITY_GATE_FAILED-task-audit:active-timeline';
const timelineFields = ['createdAt', 'enqueuedAt', 'claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt', 'resolvedAt', 'updatedAt'];

const taskSignature = (task) => JSON.stringify({
  id: task?.id || null,
  status: task?.status || null,
  createdAt: task?.createdAt || null,
  enqueuedAt: task?.enqueuedAt || null,
  claimedAt: task?.claimedAt || null,
  startedAt: task?.startedAt || null,
  reviewedAt: task?.reviewedAt || null,
  lastRecheckedAt: task?.lastRecheckedAt || null,
  resolvedAt: task?.resolvedAt || null,
  updatedAt: task?.updatedAt || null,
});

const planIdFor = (actions) => `TASK-AUDIT-REMEDIATION-${createHash('sha256').update(JSON.stringify(actions)).digest('hex').slice(0, 20)}`;

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};

const maxKnownLifecycleMs = (task) => Math.max(
  0,
  ...timelineFields
    .map((field) => parseOperationalTimestamp(task?.[field]))
    .filter(Number.isFinite),
);

/**
 * Build a human-gated plan. Only a stale updatedAt field is eligible for the
 * automatic follow-up; any other lifecycle contradiction stays manual.
 */
export const buildTaskAuditRemediationPlan = ({ taskQueue = { tasks: [] }, audit = {}, generatedAt = new Date().toISOString() } = {}) => {
  const tasks = Array.isArray(taskQueue?.tasks) ? taskQueue.tasks : [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const actions = (audit.activeViolations || []).map((item) => {
    const task = byId.get(item.taskId);
    const safeUpdatedAtOnly = Boolean(task) && item.violations.length > 0 && item.violations.every((violation) => violation.field === 'updatedAt');
    return {
      taskId: item.taskId,
      sourceSignature: taskSignature(task),
      safeUpdatedAtOnly,
      violationCount: item.violations.length,
      violations: item.violations,
      correction: safeUpdatedAtOnly ? { updatedAt: 'APPLY_TIME_AFTER_H01_APPROVAL' } : null,
    };
  });
  const eligible = actions.filter((action) => action.safeUpdatedAtOnly);
  const ineligible = actions.filter((action) => !action.safeUpdatedAtOnly);
  const status = !actions.length ? 'NO_ACTION' : ineligible.length ? 'MANUAL_REVIEW_REQUIRED' : 'READY_FOR_H01_APPROVAL';
  return {
    schemaVersion: PLAN_SCHEMA,
    planId: planIdFor(actions),
    status,
    requiredPrincipal: H01,
    requiredApprovalId: APPROVAL_ID,
    generatedAt,
    actionCount: actions.length,
    eligibleActionCount: eligible.length,
    ineligibleActionCount: ineligible.length,
    actions,
    guardrail: 'H-01 승인 전 활성 업무를 변경하지 않습니다. 승인 후에도 계획 시그니처가 현재 원장과 다르면 자동 적용을 중단합니다.',
  };
};

export const writeTaskAuditRemediationPlan = async (planPath, plan) => {
  if (!planPath || !plan) throw new Error('감사 정정 계획 경로와 내용이 필요합니다.');
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return plan;
};

/** Apply only an approved, unchanged plan; otherwise perform no write. */
export const applyApprovedTaskAuditRemediation = async ({ plan, queuePath, approvalInboxPath, remediationLogPath, approvedAt = new Date().toISOString() } = {}) => {
  if (!plan || !queuePath || !approvalInboxPath || !remediationLogPath) throw new Error('감사 정정 계획·큐·승인 대기열·정정 로그 경로가 필요합니다.');
  if (plan.status === 'NO_ACTION') return { status: 'NO_ACTION', appliedTaskIds: [] };
  if (plan.status !== 'READY_FOR_H01_APPROVAL') return { status: 'MANUAL_REVIEW_REQUIRED', appliedTaskIds: [] };
  const approvalInbox = await readJson(approvalInboxPath, { items: [] });
  const approval = (approvalInbox.items || []).find((item) => item.approvalId === plan.requiredApprovalId);
  if (!approval || approval.status !== 'APPROVED' || approval.decidedBy !== H01) {
    return { status: 'WAITING_FOR_H01_APPROVAL', appliedTaskIds: [], approvalId: plan.requiredApprovalId };
  }
  const queue = await readJson(queuePath, { tasks: [] });
  if (!Array.isArray(queue.tasks)) throw new Error('활성 업무 큐 형식이 올바르지 않습니다.');
  const taskById = new Map(queue.tasks.map((task) => [task.id, task]));
  const stale = plan.actions.filter((action) => taskSignature(taskById.get(action.taskId)) !== action.sourceSignature);
  if (stale.length) return { status: 'STALE_PLAN', appliedTaskIds: [], staleTaskIds: stale.map((action) => action.taskId), approvalId: approval.approvalId };
  const approvedMs = parseOperationalTimestamp(approval.decidedAt) || parseOperationalTimestamp(approvedAt) || Date.now();
  const appliedAt = new Date(Math.max(Date.now(), approvedMs, ...plan.actions.map((action) => maxKnownLifecycleMs(taskById.get(action.taskId))))) .toISOString();
  const original = [];
  const tasks = queue.tasks.map((task) => {
    const action = plan.actions.find((candidate) => candidate.taskId === task.id);
    if (!action) return task;
    original.push({ taskId: task.id, updatedAt: task.updatedAt || null });
    return { ...task, updatedAt: appliedAt, auditRemediationId: plan.planId, auditRemediatedAt: appliedAt, auditRemediatedBy: H01 };
  });
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify({ ...queue, tasks }, null, 2)}\n`, 'utf8');
  await mkdir(dirname(remediationLogPath), { recursive: true });
  await appendFile(remediationLogPath, `${JSON.stringify({ schemaVersion: LOG_SCHEMA, planId: plan.planId, approvalId: approval.approvalId, approvedBy: H01, approvedAt: approval.decidedAt, appliedAt, original, correctedTaskIds: plan.actions.map((action) => action.taskId) })}\n`, 'utf8');
  return { status: 'APPLIED', appliedTaskIds: plan.actions.map((action) => action.taskId), appliedAt, approvalId: approval.approvalId };
};

export { APPROVAL_ID, PLAN_SCHEMA };

