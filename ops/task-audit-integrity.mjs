import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { parseOperationalTimestamp } from './operational-time.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'working', 'review']);
const ARCHIVE_SCHEMA = 'TASK-QUEUE-ARCHIVE-0.1';
const CORRECTION_SCHEMA = 'TASK-QUEUE-AUDIT-CORRECTION-0.1';

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};

const readJsonl = async (path) => {
  try {
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
    return lines.map((line, index) => ({ lineNumber: index + 1, record: JSON.parse(line) }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const timelineFields = ['createdAt', 'enqueuedAt', 'claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt', 'resolvedAt', 'updatedAt'];
const timelineViolations = (task) => {
  const parsed = Object.fromEntries(timelineFields.map((field) => [field, parseOperationalTimestamp(task?.[field])]));
  const violations = [];
  const created = parsed.createdAt;
  if (created !== null) {
    for (const field of ['enqueuedAt', 'claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt', 'resolvedAt', 'updatedAt']) {
      if (parsed[field] !== null && parsed[field] < created) violations.push({ field, before: 'createdAt' });
    }
  }
  if (parsed.resolvedAt !== null) {
    for (const field of ['enqueuedAt', 'claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt']) {
      if (parsed[field] !== null && parsed.resolvedAt < parsed[field]) violations.push({ field: 'resolvedAt', before: field });
    }
  }
  if (parsed.updatedAt !== null) {
    for (const field of ['createdAt', 'enqueuedAt', 'claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt', 'resolvedAt']) {
      if (parsed[field] !== null && parsed.updatedAt < parsed[field]) violations.push({ field: 'updatedAt', before: field });
    }
  }
  return violations;
};

const correctionSignature = (task) => JSON.stringify({ id: task?.id || null, createdAt: task?.createdAt || null, enqueuedAt: task?.enqueuedAt || null, claimedAt: task?.claimedAt || null, resolvedAt: task?.resolvedAt || null, updatedAt: task?.updatedAt || null });

const correctedResolutionTime = (task, generatedAt) => {
  const candidateMs = parseOperationalTimestamp(generatedAt) || Date.now();
  const priorMs = timelineFields
    .filter((field) => field !== 'resolvedAt' && field !== 'updatedAt')
    .map((field) => parseOperationalTimestamp(task?.[field]))
    .filter(Number.isFinite);
  return new Date(Math.max(candidateMs, ...priorMs, 0) + 1).toISOString();
};

const latestArchivedTasks = (records) => {
  const tasks = new Map();
  const corrections = new Map();
  for (const { record } of records) {
    if (record?.schemaVersion === ARCHIVE_SCHEMA && record.task?.id) tasks.set(record.task.id, record.task);
    if (record?.schemaVersion === CORRECTION_SCHEMA && record.targetTaskId && record.correctedTask) {
      corrections.set(record.targetTaskId, record);
      tasks.set(record.targetTaskId, record.correctedTask);
    }
  }
  return { tasks, corrections };
};

/** Audit task lifecycle ordering; repair only archive projections via append-only corrections. */
export const auditTaskTimeline = async ({ queuePath, archivePath, generatedAt = new Date().toISOString(), repair = true } = {}) => {
  if (!queuePath || !archivePath) throw new Error('활성 업무 큐와 아카이브 경로가 필요합니다.');
  const queue = await readJson(queuePath, { tasks: [] });
  if (!Array.isArray(queue.tasks)) throw new Error('활성 업무 큐 형식이 올바르지 않습니다.');
  const records = await readJsonl(archivePath);
  const { tasks: archivedTasks, corrections } = latestArchivedTasks(records);
  const activeViolations = queue.tasks
    .filter((task) => ACTIVE_STATUSES.has(task?.status))
    .map((task) => ({ taskId: task.id || null, violations: timelineViolations(task) }))
    .filter((item) => item.violations.length);
  const rawArchiveTasks = records
    .filter(({ record }) => record?.schemaVersion === ARCHIVE_SCHEMA && record.task?.id)
    .map(({ record }) => record.task);
  const archiveViolations = rawArchiveTasks
    .map((task) => ({ task, violations: timelineViolations(task), signature: correctionSignature(task) }))
    .filter((item) => item.violations.length);
  const correctionsToAppend = archiveViolations
    .filter((item) => ![...corrections.values()].some((correction) => correction.sourceSignature === item.signature))
    .map((item) => {
      const correctedAt = correctedResolutionTime(item.task, generatedAt);
      const correctedTask = { ...item.task, resolvedAt: correctedAt, updatedAt: correctedAt };
      const correctionId = `TASK-TIMELINE-CORRECTION-${createHash('sha256').update(item.signature).digest('hex').slice(0, 20)}`;
      return {
        schemaVersion: CORRECTION_SCHEMA,
        correctionId,
        targetTaskId: item.task.id,
        sourceSignature: item.signature,
        original: { resolvedAt: item.task.resolvedAt || null, updatedAt: item.task.updatedAt || null },
        correctedTask,
        correctedAt: generatedAt,
        correctedBy: 'SYSTEM',
        reason: 'RESOLUTION_TIMESTAMP_BEFORE_TASK_LIFECYCLE_TIMESTAMP',
      };
    });
  if (repair && correctionsToAppend.length) {
    await mkdir(dirname(archivePath), { recursive: true });
    await appendFile(archivePath, `${correctionsToAppend.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    for (const correction of correctionsToAppend) archivedTasks.set(correction.targetTaskId, correction.correctedTask);
  }
  const effectiveViolations = [...archivedTasks.values()]
    .map((task) => ({ taskId: task.id || null, violations: timelineViolations(task) }))
    .filter((item) => item.violations.length);
  return {
    schemaVersion: 'TASK-AUDIT-INTEGRITY-0.1',
    status: activeViolations.length ? 'ACTIVE_TIMELINE_INVALID' : correctionsToAppend.length && repair ? 'CORRECTED_ARCHIVE_TIMELINE' : effectiveViolations.length ? 'ARCHIVE_TIMELINE_INVALID' : 'VALID',
    activeViolationCount: activeViolations.length,
    archiveViolationCount: archiveViolations.length,
    correctedCount: repair ? correctionsToAppend.length : 0,
    remainingArchiveViolationCount: effectiveViolations.length,
    activeViolations,
    correctedTaskIds: correctionsToAppend.map((record) => record.targetTaskId),
    generatedAt,
    guardrail: '자동업무 감사 원본은 삭제·덮어쓰지 않고 정정 이벤트만 append-only로 추가합니다. 활성 업무 시간 오류는 자동 수정하지 않고 H-01 검토로 승격합니다.',
  };
};

