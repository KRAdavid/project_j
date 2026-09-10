import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DECISION_STATUS = {
  approve: 'APPROVED',
  request_changes: 'CHANGES_REQUESTED',
  hold: 'HELD',
  reject: 'REJECTED',
};

export class ApprovalStoreError extends Error {
  constructor(message, code = 'APPROVAL_STORE_ERROR') {
    super(message);
    this.code = code;
  }
}

const ensureParent = async (filePath) => mkdir(dirname(filePath), { recursive: true });

export const readApprovalInbox = async (inboxPath) => {
  try {
    return JSON.parse(await readFile(inboxPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new ApprovalStoreError('승인 대기열을 찾을 수 없습니다.', 'APPROVAL_INBOX_NOT_FOUND');
    throw error;
  }
};

export const decideApproval = async (inboxPath, decisionLogPath, approvalId, { decision, decidedBy, decidedAt = new Date().toISOString(), note = '' } = {}) => {
  const status = DECISION_STATUS[String(decision || '').trim()];
  if (!status) throw new ApprovalStoreError('승인 결정은 approve·request_changes·hold·reject 중 하나여야 합니다.', 'APPROVAL_DECISION_INVALID');
  if (!decidedBy) throw new ApprovalStoreError('승인자 식별자가 필요합니다.', 'APPROVER_REQUIRED');
  const inbox = await readApprovalInbox(inboxPath);
  const item = Array.isArray(inbox.items) ? inbox.items.find((candidate) => candidate.approvalId === approvalId) : null;
  if (!item) throw new ApprovalStoreError('승인 대상을 찾을 수 없습니다.', 'APPROVAL_NOT_FOUND');
  if (item.status !== 'PENDING') {
    if (item.status === status && item.decidedBy === decidedBy) return { inbox, item, idempotent: true };
    throw new ApprovalStoreError('이미 결정된 승인 대상은 다시 변경할 수 없습니다.', 'APPROVAL_ALREADY_DECIDED');
  }
  const updatedItem = { ...item, status, decision, decidedBy, decidedAt, decisionNote: String(note || '').slice(0, 2000) };
  const updatedItems = inbox.items.map((candidate) => candidate.approvalId === approvalId ? updatedItem : candidate);
  const updatedInbox = {
    ...inbox,
    generatedAt: decidedAt,
    status: updatedItems.some((candidate) => candidate.status === 'PENDING') ? 'PENDING' : 'CLEAR',
    items: updatedItems,
  };
  await ensureParent(inboxPath);
  await writeFile(inboxPath, `${JSON.stringify(updatedInbox, null, 2)}\n`, 'utf8');
  await ensureParent(decisionLogPath);
  await appendFile(decisionLogPath, `${JSON.stringify({ schemaVersion: 'APPROVAL-AUDIT-0.1', approvalId, decision, status, decidedBy, decidedAt, note: updatedItem.decisionNote, taskId: item.taskId, sourceRunId: item.sourceRunId })}\n`, 'utf8');
  return { inbox: updatedInbox, item: updatedItem, idempotent: false };
};

export { DECISION_STATUS };
