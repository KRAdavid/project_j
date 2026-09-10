import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readApprovalInbox } from './approval-store.mjs';

const ensureParent = async (filePath) => mkdir(dirname(filePath), { recursive: true });

export const appendAutopilotRun = async (historyPath, run) => {
  if (!historyPath) throw new Error('자동운영 이력 저장 경로가 필요합니다.');
  await ensureParent(historyPath);
  const auditRecord = {
    schemaVersion: 'AUTOPILOT-LEDGER-0.1',
    runId: run.runId,
    generatedAt: run.generatedAt,
    decision: run.decision,
    selectedTaskId: run.selectedTask?.id || null,
    workPacketId: run.workPacket?.packetId || null,
    workPacketStatus: run.workPacket?.status || null,
    patentPacketId: run.patentPacket?.packetId || null,
    selectionType: run.selectionType,
    evidence: run.evidence.map(({ name, passed, skipped, command }) => ({ name, passed, skipped: Boolean(skipped), command })),
    authority: run.authority,
  };
  await appendFile(historyPath, `${JSON.stringify(auditRecord)}\n`, 'utf8');
  return auditRecord;
};

export const buildApprovalInbox = (run) => {
  const items = [];
  if (run.selectedTask && run.decision === 'HUMAN_REVIEW_REQUIRED') {
    items.push({
      approvalId: `APPROVAL-${run.runId}`,
      status: 'PENDING',
      requiredPrincipal: 'H-01',
      taskId: run.selectedTask.id,
      objective: run.selectedTask.objective,
      risk: run.selectedTask.risk,
      reviewers: run.selectedTask.reviewers,
      options: ['approve', 'request_changes', 'hold', 'reject'],
      sourceRunId: run.runId,
      createdAt: run.generatedAt,
    });
  }
  for (const task of run.automation?.triggerTasks || []) {
    items.push({
      approvalId: `APPROVAL-TRIGGER-${task.id}`,
      status: 'PENDING',
      requiredPrincipal: 'H-01',
      taskId: task.id,
      objective: task.objective,
      risk: task.risk,
      reviewers: task.reviewers,
      options: ['approve', 'request_changes', 'hold', 'reject'],
      sourceRunId: run.runId,
      triggerKey: task.triggerKey,
      createdAt: run.generatedAt,
    });
  }
  const skipped = run.evidence.filter((item) => item.skipped).map((item) => ({ name: item.name, output: item.output || '' }));
  return {
    schemaVersion: 'APPROVAL-INBOX-0.1',
    generatedAt: run.generatedAt,
    status: items.length ? 'PENDING' : 'CLEAR',
    items,
    unresolvedEvidence: skipped,
    guardrail: '이 파일은 승인 대기 패킷이다. AI 또는 자동화가 승인 상태를 변경하지 않는다.',
  };
};

export const writeApprovalInbox = async (inboxPath, run) => {
  if (!inboxPath) throw new Error('승인 대기열 저장 경로가 필요합니다.');
  await ensureParent(inboxPath);
  const inbox = buildApprovalInbox(run);
  try {
    const prior = JSON.parse(await readFile(inboxPath, 'utf8'));
    const priorByTask = new Map((prior.items || []).map((item) => [item.taskId, item]));
    inbox.items = inbox.items.map((item) => {
      const previous = priorByTask.get(item.taskId);
      if (!previous || previous.status === 'PENDING') return item;
      // A new run is a new review packet. Never carry an old human decision
      // into it: the evidence, source revision, or risk scope may have changed.
      // Keep the prior decision only as context for H-01; the new item remains
      // actionable and must be decided again.
      return {
        ...item,
        status: 'PENDING',
        supersedesApprovalId: previous.approvalId,
        supersededDecision: previous.decision || null,
        supersededStatus: previous.status,
        supersededAt: previous.decidedAt || null,
      };
    });
    inbox.status = inbox.items.some((item) => item.status === 'PENDING') ? 'PENDING' : 'CLEAR';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(inboxPath, `${JSON.stringify(inbox, null, 2)}\n`, 'utf8');
  return inbox;
};

export const mergeTriggerApprovalItems = async (inboxPath, triggerTasks = [], { sourceRunId = 'UNKNOWN-RUN', generatedAt = new Date().toISOString() } = {}) => {
  if (!inboxPath) throw new Error('승인 대기열 저장 경로가 필요합니다.');
  const inbox = await readApprovalInbox(inboxPath);
  const items = Array.isArray(inbox.items) ? [...inbox.items] : [];
  const existingTaskIds = new Set(items.map((item) => item.taskId));
  const additions = [];
  for (const task of triggerTasks) {
    if (!task?.id || existingTaskIds.has(task.id)) continue;
    const item = {
      approvalId: `APPROVAL-TRIGGER-${task.id}`,
      status: 'PENDING',
      requiredPrincipal: 'H-01',
      taskId: task.id,
      objective: task.objective,
      risk: task.risk,
      reviewers: task.reviewers,
      options: ['approve', 'request_changes', 'hold', 'reject'],
      sourceRunId,
      triggerKey: task.triggerKey,
      createdAt: generatedAt,
    };
    items.push(item);
    additions.push(item);
    existingTaskIds.add(task.id);
  }
  const updatedInbox = {
    ...inbox,
    generatedAt,
    status: items.some((item) => item.status === 'PENDING') ? 'PENDING' : 'CLEAR',
    items,
  };
  await ensureParent(inboxPath);
  await writeFile(inboxPath, `${JSON.stringify(updatedInbox, null, 2)}\n`, 'utf8');
  return { inbox: updatedInbox, additions };
};

export const readAutopilotHistory = async (historyPath) => {
  try {
    const content = await readFile(historyPath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

