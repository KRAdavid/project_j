import { parseOperationalTimestamp } from './operational-time.mjs';

export const DEFAULT_TASK_SLA_HOURS = {
  queued: { critical: 24, high: 48, medium: 72, low: 120 },
  working: { critical: 48, high: 72, medium: 120, low: 168 },
  review: { critical: 24, high: 48, medium: 72, low: 120 },
};

const ACTIVE_STATUSES = new Set(['queued', 'working', 'review']);

const parseTime = (value) => {
  const parsed = parseOperationalTimestamp(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const thresholdFor = (status, risk, slaHours) => {
  const statusPolicy = slaHours?.[status] || {};
  const value = Number(statusPolicy[risk] ?? statusPolicy.high);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Evaluate task age without inventing missing lifecycle history. */
export const evaluateTaskSla = ({ tasks = [], now = new Date(), slaHours = DEFAULT_TASK_SLA_HOURS } = {}) => {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('업무 SLA 기준시각이 올바르지 않습니다.');

  const evaluated = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => ACTIVE_STATUSES.has(task?.status))
    .map((task) => {
      const createdMs = parseTime(task.createdAt);
      const claimedMs = parseTime(task.claimedAt);
      const baselineMs = task.status === 'queued' ? createdMs : claimedMs;
      const thresholdHours = thresholdFor(task.status, task.risk || 'high', slaHours);
      const metadataComplete = baselineMs !== null && thresholdHours !== null;
      const ageHours = metadataComplete ? Math.max(0, (nowMs - baselineMs) / 3600000) : null;
      const stale = metadataComplete && ageHours >= thresholdHours;
      return {
        taskId: task.id || null,
        status: task.status,
        risk: task.risk || 'high',
        ownerAi: task.ownerAi || null,
        createdAt: task.createdAt || null,
        claimedAt: task.claimedAt || null,
        ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
        thresholdHours,
        metadataComplete,
        stale,
        action: stale ? 'ESCALATE_AI01_AND_H01' : 'CONTINUE_WITHIN_SLA',
      };
    });

  return {
    evaluatedAt: new Date(nowMs).toISOString(),
    activeCount: evaluated.length,
    metadataCompleteCount: evaluated.filter((item) => item.metadataComplete).length,
    staleCount: evaluated.filter((item) => item.stale).length,
    status: evaluated.some((item) => item.stale) ? 'STALE_TASKS' : 'WITHIN_SLA',
    humanPrincipal: 'H-01',
    items: evaluated,
  };
};
