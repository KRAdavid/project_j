import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TERMINAL_STATUSES = new Set(['done', 'approved', 'rejected', 'resolved']);

const readJsonlIds = async (archivePath) => {
  try {
    const lines = (await readFile(archivePath, 'utf8')).split(/\r?\n/).filter(Boolean);
    return new Set(lines.map((line) => JSON.parse(line)?.task?.id).filter(Boolean));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
};

/**
 * Move terminal tasks out of the hot queue while preserving an append-only
 * audit record. The archive is written before the active queue is replaced;
 * if the archive write fails, the active queue is left untouched.
 */
export const compactTaskQueue = async (queuePath, archivePath, { generatedAt = new Date().toISOString() } = {}) => {
  if (!queuePath || !archivePath) throw new Error('업무 큐와 보관 원장 경로가 필요합니다.');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  if (!Array.isArray(queue.tasks)) throw new Error('자동 업무 큐 형식이 올바르지 않습니다.');
  const terminalTasks = queue.tasks.filter((task) => TERMINAL_STATUSES.has(task?.status));
  if (!terminalTasks.length) return { archivedCount: 0, remainingCount: queue.tasks.length, queue };

  const archivedIds = await readJsonlIds(archivePath);
  const newRecords = terminalTasks
    .filter((task) => !archivedIds.has(task.id))
    .map((task) => JSON.stringify({ schemaVersion: 'TASK-QUEUE-ARCHIVE-0.1', archivedAt: generatedAt, task }));
  await mkdir(dirname(archivePath), { recursive: true });
  if (newRecords.length) await appendFile(archivePath, `${newRecords.join('\n')}\n`, 'utf8');

  const activeTasks = queue.tasks.filter((task) => !TERMINAL_STATUSES.has(task?.status));
  const compactedQueue = { ...queue, tasks: activeTasks, compactedAt: generatedAt, archivedTaskCount: (queue.archivedTaskCount || 0) + terminalTasks.length };
  await writeFile(queuePath, `${JSON.stringify(compactedQueue, null, 2)}\n`, 'utf8');
  return { archivedCount: terminalTasks.length, newArchiveRecords: newRecords.length, remainingCount: activeTasks.length, queue: compactedQueue };
};

export { TERMINAL_STATUSES };

