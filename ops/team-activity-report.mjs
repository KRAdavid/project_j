import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ACTIVE_STATUSES = new Set(['queued', 'working', 'review']);
const H01_ID = 'H-01';

const isMemberReference = (reference, member) => {
  const value = String(reference || '');
  return value === member.id || value.startsWith(`${member.id} `);
};

const taskTouchesMember = (task, member) => (
  isMemberReference(task?.ownerAi, member)
  || (Array.isArray(task?.reviewers) && task.reviewers.some((reviewer) => isMemberReference(reviewer, member)))
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
} = {}) => {
  const pendingIds = pendingApprovalTaskIds instanceof Set
    ? pendingApprovalTaskIds
    : new Set(Array.isArray(pendingApprovalTaskIds) ? pendingApprovalTaskIds : []);

  const members = (Array.isArray(roster) ? roster : []).map((member) => {
    const memberTasks = (Array.isArray(tasks) ? tasks : []).filter((task) => taskTouchesMember(task, member));
    const activeTasks = memberTasks.filter((task) => ACTIVE_STATUSES.has(task?.status));
    const waitingTasks = activeTasks.filter((task) => pendingIds.has(task.id));
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
    } else if (selected) {
      status = 'AUTO_EXECUTING';
      reason = '현재 운영 사이클이 안전한 분석·검증·준비 작업을 실행 중입니다.';
    } else if (activeTasks.length) {
      status = 'AUTO_QUEUE_ACTIVE';
      reason = `활성 업무 ${activeTasks.length}건이 큐에서 다음 자동 실행을 기다립니다.`;
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
      waitingApprovalTaskIds: waitingTasks.map((task) => task.id),
      allowedActions: member.id === H01_ID
        ? ['FINAL_DECISION', 'APPROVE_OR_HOLD', 'TRADE_STOP']
        : ['ANALYZE', 'RUN_TESTS', 'WRITE_REVIEW_PACKET', 'RAISE_RISK_SIGNAL'],
      forbiddenActions: member.id === H01_ID
        ? []
        : ['TRADE_FINALIZATION', 'CONTRACT_FINALIZATION', 'PAYMENT_RELEASE', 'DISPUTE_CLOSURE', 'PRODUCTION_CUTOVER'],
    };
  });

  return {
    schemaVersion: 'TEAM-ACTIVITY-0.1',
    generatedAt,
    cycleId,
    truthModel: 'RULE_DRIVEN_AUTOMATION_NOT_CONTINUOUS_LLM_BACKGROUND_THOUGHT',
    executionSummary: {
      automaticPreparation: true,
      selectedTaskId: selectedTask?.id || null,
      workPacketId: workPacket?.packetId || null,
      triggerTasksPending: Number(automation.triggerInboxPending || 0),
      readinessDecision: readiness.decision || 'UNKNOWN',
      readinessMissing: Array.isArray(readiness.missing) ? readiness.missing : [],
    },
    counts: summarizeCounts(members),
    members,
    guardrail: 'AI는 분석·검증·준비만 자동 수행하며 실제 거래·계약·결제·운영 재개는 H-01 승인 없이는 수행하지 않는다.',
  };
};

export const writeTeamActivityReport = async (reportPath, report) => {
  if (!reportPath || !report) throw new Error('팀 활동 보고서 경로와 내용이 필요합니다.');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
};


