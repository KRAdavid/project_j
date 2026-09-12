import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseOperationalTimestamp } from './operational-time.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'working', 'review']);
const TIMELINE_FIELDS = ['createdAt', 'enqueuedAt', 'claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt', 'resolvedAt', 'updatedAt'];

const readQueue = async (queuePath) => {
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  if (!Array.isArray(queue.tasks)) throw new Error('자동 업무 큐 형식이 올바르지 않습니다.');
  return queue;
};

const latestKnownMs = (task) => Math.max(
  0,
  ...TIMELINE_FIELDS
    .map((field) => parseOperationalTimestamp(task?.[field]))
    .filter(Number.isFinite),
);

/**
 * Record only the evidence produced by the current autopilot run.
 * Historical lifecycle timestamps are never reconstructed or overwritten.
 */
export const recordAutopilotExecution = async ({
  queuePath,
  auditPath,
  selectedTaskId,
  runId,
  generatedAt = new Date().toISOString(),
  decision = 'UNKNOWN',
  allowQueued = false,
} = {}) => {
  if (!queuePath || !auditPath) throw new Error('자동 실행 증거의 큐·감사 로그 경로가 필요합니다.');
  if (!selectedTaskId) return { status: 'NO_TASK', taskId: null };
  const generatedMs = parseOperationalTimestamp(generatedAt);
  if (!Number.isFinite(generatedMs)) throw new Error('자동 실행 증거 시각 형식이 올바르지 않습니다.');

  const queue = await readQueue(queuePath);
  const index = queue.tasks.findIndex((task) => task?.id === selectedTaskId);
  if (index < 0) return { status: 'TASK_NOT_FOUND', taskId: selectedTaskId };
  const prior = queue.tasks[index];
  if (!ACTIVE_STATUSES.has(prior.status)) return { status: 'TASK_NOT_ACTIVE', taskId: selectedTaskId };
  if (prior.status === 'queued' && !allowQueued) return { status: 'WAITING_FOR_CLAIM', taskId: selectedTaskId };

  const updatedAt = new Date(Math.max(generatedMs, latestKnownMs(prior))).toISOString();
  const current = {
    ...prior,
    lastRecheckedAt: generatedAt,
    lastRecheckResult: `AUTOPILOT_${decision}`,
    updatedAt,
  };
  queue.tasks[index] = current;
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');

  const auditRecord = {
    schemaVersion: 'AUTOPILOT-EXECUTION-EVIDENCE-0.1',
    runId: runId || null,
    taskId: selectedTaskId,
    recordedAt: generatedAt,
    decision,
    actor: 'SYSTEM_AUTOPILOT',
    prior: {
      status: prior.status,
      claimedAt: prior.claimedAt || null,
      startedAt: prior.startedAt || null,
      reviewedAt: prior.reviewedAt || null,
      lastRecheckedAt: prior.lastRecheckedAt || null,
      updatedAt: prior.updatedAt || null,
    },
    current: {
      status: current.status,
      lastRecheckedAt: current.lastRecheckedAt,
      lastRecheckResult: current.lastRecheckResult,
      updatedAt: current.updatedAt,
    },
    guardrail: '자동 실행은 분석·검증·검토 패킷 증거만 기록하며 거래·계약·결제·운영 재개를 승인하지 않는다.',
  };
  await mkdir(dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(auditRecord)}\n`, 'utf8');
  return { status: 'RECORDED', taskId: selectedTaskId, auditRecord };
};


