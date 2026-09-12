import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ACTIVE_STATUSES = new Set(['queued', 'working', 'review']);
const EXECUTION_EVIDENCE_FIELDS = ['claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt'];
const H01_ID = 'H-01';
const DEFAULT_AI_ALLOWED_ACTIONS = ['ANALYZE', 'RUN_TESTS', 'WRITE_REVIEW_PACKET', 'RAISE_RISK_SIGNAL'];
const DEFAULT_AI_FORBIDDEN_ACTIONS = ['TRADE_FINALIZATION', 'CONTRACT_FINALIZATION', 'PAYMENT_RELEASE', 'DISPUTE_CLOSURE', 'PRODUCTION_CUTOVER'];
const DEFAULT_H01_ALLOWED_ACTIONS = ['FINAL_DECISION', 'APPROVE_OR_HOLD', 'TRADE_STOP'];

const isMemberReference = (reference, member) => {
  const value = String(reference || '');
  return value === member.id || value.startsWith(`${member.id} `);
};

const taskTouchesMember = (task, member) => (
  isMemberReference(task?.ownerAi, member)
  || (Array.isArray(task?.reviewers) && task.reviewers.some((reviewer) => isMemberReference(reviewer, member)))
);

const hasExecutionEvidence = (task, { selectedTask = null, workPacket = null, evidenceFields = EXECUTION_EVIDENCE_FIELDS } = {}) => (
  evidenceFields.some((field) => Boolean(task?.[field]))
  || (selectedTask?.id === task?.id && workPacket?.taskId === task?.id && Boolean(workPacket?.generatedAt || workPacket?.packetId))
);

const summarizeCounts = (members) => members.reduce((counts, member) => {
  counts[member.status] = (counts[member.status] || 0) + 1;
  return counts;
}, {});

/**
 * Produce an auditable distinction between automatic preparation and human gates.
 * This is intentionally a workflow report, not a claim that an LLM is thinking
 * continuously in the background.
 */
export const buildTeamActivityReport = ({
  roster = [],
  tasks = [],
  selectedTask = null,
  pendingApprovalTaskIds = new Set(),
  readiness = {},
  cycleId = null,
  generatedAt = new Date().toISOString(),
  automation = {},
  workPacket = null,
  policy = {},
} = {}) => {
  const evidenceFields = Array.isArray(policy.executionEvidenceFields) && policy.executionEvidenceFields.length
    ? policy.executionEvidenceFields
    : EXECUTION_EVIDENCE_FIELDS;
  const aiAllowedActions = Array.isArray(policy.automaticPreparationActions) && policy.automaticPreparationActions.length
    ? policy.automaticPreparationActions
    : DEFAULT_AI_ALLOWED_ACTIONS;
  const aiForbiddenActions = Array.isArray(policy.humanApprovalRequiredActions) && policy.humanApprovalRequiredActions.length
    ? policy.humanApprovalRequiredActions
    : DEFAULT_AI_FORBIDDEN_ACTIONS;
  const h01AllowedActions = Array.isArray(policy.humanAllowedActions) && policy.humanAllowedActions.length
    ? policy.humanAllowedActions
    : DEFAULT_H01_ALLOWED_ACTIONS;
  const pendingIds = pendingApprovalTaskIds instanceof Set
    ? pendingApprovalTaskIds
    : new Set(Array.isArray(pendingApprovalTaskIds) ? pendingApprovalTaskIds : []);

  const members = (Array.isArray(roster) ? roster : []).map((member) => {
    const memberTasks = (Array.isArray(tasks) ? tasks : []).filter((task) => taskTouchesMember(task, member));
    const activeTasks = memberTasks.filter((task) => ACTIVE_STATUSES.has(task?.status));
    const waitingTasks = activeTasks.filter((task) => pendingIds.has(task.id));
    const taskHasEvidence = (task) => hasExecutionEvidence(task, { selectedTask, workPacket, evidenceFields });
    const unverifiedTasks = activeTasks.filter((task) => ['working', 'review'].includes(task?.status) && !taskHasEvidence(task));
    const queuedTasks = activeTasks.filter((task) => task?.status === 'queued');
    const selected = selectedTask && isMemberReference(selectedTask.ownerAi, member) ? selectedTask : null;

    let status;
    let reason;
    if (member.id === H01_ID) {
      status = pendingIds.size ? 'WAITING_FOR_H01' : 'READY_FOR_DECISION';
      reason = pendingIds.size
        ? `승인 대기 ${pendingIds.size}건이 대표 결정함에 있습니다.`
        : '현재 승인 대기 항목이 없습니다.';
    } else if (waitingTasks.length) {
      status = 'WAITING_FOR_H01';
      reason = `담당·검토 업무 ${waitingTasks.length}건이 H-01 승인 대기입니다.`;
    } else if (selected && taskHasEvidence(selected)) {
      status = 'AUTO_EXECUTING';
      reason = '현재 운영 사이클이 안전한 분석·검증·준비 작업을 실행 중입니다.';
    } else if (unverifiedTasks.length) {
      status = 'UNVERIFIED_ACTIVE';
      reason = `활성 상태지만 인수·착수·재검토 시각이 없는 업무 ${unverifiedTasks.length}건은 실행 중으로 인정하지 않습니다.`;
    } else if (queuedTasks.length) {
      status = 'AUTO_QUEUE_ACTIVE';
      reason = `검증 가능한 대기 업무 ${queuedTasks.length}건이 다음 자동 실행을 기다립니다.`;
    } else if (activeTasks.length) {
      status = 'AUTO_QUEUE_ACTIVE';
      reason = `실행 시각이 기록된 활성 업무 ${activeTasks.length}건이 다음 자동 실행을 기다립니다.`;
    } else {
      status = 'IDLE';
      reason = '현재 배정된 활성 업무가 없습니다.';
    }

    return {
      id: member.id,
      kind: member.kind,
      name: member.name,
      role: member.role,
      autonomy: member.autonomy,
      status,
      reason,
      selectedTaskId: selected?.id || null,
      activeTaskIds: activeTasks.map((task) => task.id),
      executionEvidenceTaskIds: activeTasks.filter(taskHasEvidence).map((task) => task.id),
      unverifiedActiveTaskIds: unverifiedTasks.map((task) => task.id),
      waitingApprovalTaskIds: waitingTasks.map((task) => task.id),
      allowedActions: member.id === H01_ID ? h01AllowedActions : aiAllowedActions,
      forbiddenActions: member.id === H01_ID ? [] : aiForbiddenActions,
    };
  });

  return {
    schemaVersion: 'TEAM-ACTIVITY-0.1',
    generatedAt,
    cycleId,
    truthModel: policy.truthModel || 'RULE_DRIVEN_AUTOMATION_NOT_CONTINUOUS_LLM_BACKGROUND_THOUGHT',
    policyVersion: policy.schemaVersion || null,
    executionSummary: {
      automaticPreparation: true,
      independentPreparationContinuesWhileApprovalPending: true,
      pendingApprovalCount: pendingIds.size,
      selectedTaskId: selectedTask?.id || null,
      workPacketId: workPacket?.packetId || null,
      triggerTasksPending: Number(automation.triggerInboxPending || 0),
      readinessDecision: readiness.decision || 'UNKNOWN',
      readinessMissing: Array.isArray(readiness.missing) ? readiness.missing : [],
      automaticPreparationActions: aiAllowedActions,
      humanApprovalRequiredActions: Array.isArray(policy.humanApprovalRequiredActions)
        ? policy.humanApprovalRequiredActions
        : DEFAULT_AI_FORBIDDEN_ACTIONS,
      executionEvidenceFields: evidenceFields,
    },
    counts: summarizeCounts(members),
    members,
    guardrail: policy.guardrail || 'AI는 분석·검증·준비만 자동 수행하며 실제 거래·계약·결제·운영 재개는 H-01 승인 없이는 수행하지 않는다.',
  };
};

export const writeTeamActivityReport = async (reportPath, report) => {
  if (!reportPath || !report) throw new Error('팀 활동 보고서 경로와 내용이 필요합니다.');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
};

