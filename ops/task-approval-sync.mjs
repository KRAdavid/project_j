import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DECISION_TO_TASK_STATUS = {
  approve: 'approved',
  request_changes: 'working',
  hold: 'review',
  reject: 'rejected',
};

export class TaskApprovalSyncError extends Error {
  constructor(message, code = 'TASK_APPROVAL_SYNC_ERROR') {
    super(message);
    this.code = code;
  }
}

const readTaskQueue = async (queuePath) => {
  try {
    const queue = JSON.parse(await readFile(queuePath, 'utf8'));
    if (!Array.isArray(queue.tasks)) throw new TaskApprovalSyncError('업무 큐 형식이 올바르지 않습니다.', 'TASK_QUEUE_INVALID');
    return queue;
  } catch (error) {
    if (error instanceof TaskApprovalSyncError) throw error;
    if (error.code === 'ENOENT') throw new TaskApprovalSyncError('업무 큐를 찾을 수 없습니다.', 'TASK_QUEUE_NOT_FOUND');
    throw error;
  }
};

/**
 * Reflect a human approval decision into the simulation task queue.
 * This is deliberately a file-backed simulation adapter; it never enables
 * trading, payment, deployment, or participant access.
 */
export const syncTaskApproval = async ({
  queuePath,
  auditPath,
  approvalId,
  taskId,
  decision,
  decidedBy,
  decidedAt = new Date().toISOString(),
  note = '',
} = {}) => {
  const normalizedDecision = String(decision || '').trim();
  const nextStatus = DECISION_TO_TASK_STATUS[normalizedDecision];
  if (!nextStatus) throw new TaskApprovalSyncError('동기화할 승인 결정이 올바르지 않습니다.', 'TASK_APPROVAL_DECISION_INVALID');
  if (!taskId) return { status: 'NOT_APPLICABLE', taskId: null, approvalId, idempotent: true };
  if (!decidedBy) throw new TaskApprovalSyncError('인간 결정자 식별자가 필요합니다.', 'TASK_APPROVER_REQUIRED');

  const queue = await readTaskQueue(queuePath);
  const index = queue.tasks.findIndex((task) => task?.id === taskId);
  if (index < 0) return { status: 'TASK_NOT_FOUND', taskId, approvalId, idempotent: false };

  const prior = queue.tasks[index];
  if (prior.status === nextStatus && prior.lastApprovalId === approvalId && prior.lastApprovalDecision === normalizedDecision) {
    return { status: 'SYNCED', taskId, approvalId, priorStatus: prior.status, currentStatus: prior.status, idempotent: true };
  }
  if (['done', 'rejected', 'resolved'].includes(prior.status) && prior.status !== nextStatus) {
    throw new TaskApprovalSyncError('종료된 업무 상태를 승인 결정으로 되돌릴 수 없습니다.', 'TASK_ALREADY_TERMINAL');
  }

  const current = {
    ...prior,
    status: nextStatus,
    reviewedAt: decidedAt,
    lastApprovalId: approvalId || null,
    lastApprovalDecision: normalizedDecision,
    lastApprovalBy: decidedBy,
    lastApprovalAt: decidedAt,
    approvalNote: String(note || '').slice(0, 2000),
    updatedAt: decidedAt,
    nextAction: nextStatus === 'approved'
      ? '승인된 다음 작업을 준비하되, 별도 출시·거래·결제 게이트를 통과하기 전에는 운영을 재개하지 않는다.'
      : nextStatus === 'working'
        ? '수정 요청을 반영하고 새 검토 증적을 생성한다.'
        : nextStatus === 'review'
          ? 'H-01의 보류 사유와 재검토 조건을 확인한다.'
          : '반려 사유를 보존하고 해당 업무의 재개를 차단한다.',
  };
  queue.tasks[index] = current;
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify({ ...queue, updatedAt: decidedAt }, null, 2)}\n`, 'utf8');

  const auditRecord = {
    schemaVersion: 'TASK-APPROVAL-SYNC-0.1',
    approvalId: approvalId || null,
    taskId,
    decision: normalizedDecision,
    decidedBy,
    decidedAt,
    priorStatus: prior.status,
    currentStatus: current.status,
    note: current.approvalNote,
    actor: 'HUMAN_H01',
    guardrail: '승인 동기화는 시뮬레이션 작업 큐만 갱신하며 거래·계약·결제·참가자 접근·배포를 실행하지 않는다.',
  };
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(auditRecord)}\n`, 'utf8');
  return { status: 'SYNCED', taskId, approvalId, priorStatus: prior.status, currentStatus: current.status, idempotent: false, auditRecord };
};

export { DECISION_TO_TASK_STATUS };

