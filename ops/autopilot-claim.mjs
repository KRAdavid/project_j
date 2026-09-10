import { parseOperationalTimestamp } from './operational-time.mjs';

export const claimQueuedTask = (task, selectionType, { claimedAt, claimedBy = 'AI-01 세온' } = {}) => {
  if (!task || selectionType !== 'queued' || task.status !== 'queued') return { claimed: false, task };
  if (!claimedAt) throw new Error('자동 업무 인수 시각이 필요합니다.');
  const claimedMs = parseOperationalTimestamp(claimedAt);
  if (!Number.isFinite(claimedMs)) throw new Error('자동 업무 인수 시각 형식이 올바르지 않습니다.');
  task.status = 'working';
  task.claimedAt = claimedAt;
  task.claimedBy = claimedBy;
  const priorUpdatedMs = parseOperationalTimestamp(task.updatedAt);
  task.updatedAt = new Date(Math.max(claimedMs, Number.isFinite(priorUpdatedMs) ? priorUpdatedMs : 0)).toISOString();
  return { claimed: true, task };
};

