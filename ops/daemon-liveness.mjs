const LIVE_STATUSES = new Set(['RUNNING', 'CYCLE_RUNNING', 'WAITING']);

export const evaluateDaemonLiveness = (status, { now = Date.now(), maxAgeMs = 20 * 60 * 1000, processAlive = true } = {}) => {
  const updatedAt = Date.parse(status?.updatedAt || '');
  const ageMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : null;
  const pid = Number.isInteger(status?.pid) && status.pid > 0 ? status.pid : null;
  const processMissing = pid === null || processAlive === false;
  const cycleNeedsHumanReview = status?.status === 'WAITING'
    && Number(status?.lastCycle || 0) > 0
    && Number(status?.lastCycleExitCode) !== 0
    && String(status?.lastCycleDecision || '').endsWith('HUMAN_REVIEW_REQUIRED');
  const cycleHasFailed = status?.status === 'WAITING'
    && Number(status?.lastCycle || 0) > 0
    && Number(status?.lastCycleExitCode) !== 0
    && !cycleNeedsHumanReview;
  const cycleTimedOut = status?.lastCycleTimedOut === true;
  const ready = LIVE_STATUSES.has(status?.status)
    && ageMs !== null
    && ageMs <= maxAgeMs
    && !processMissing
    && !cycleNeedsHumanReview
    && !cycleHasFailed
    && !cycleTimedOut;
  const reason = ready
    ? null
    : !LIVE_STATUSES.has(status?.status)
      ? 'DAEMON_NOT_LIVE'
      : processMissing
        ? 'DAEMON_PROCESS_NOT_ALIVE'
      : cycleTimedOut
        ? 'DAEMON_LAST_CYCLE_TIMED_OUT'
        : cycleNeedsHumanReview
          ? 'DAEMON_CYCLE_REQUIRES_HUMAN_REVIEW'
        : cycleHasFailed
          ? 'DAEMON_LAST_CYCLE_FAILED'
          : ageMs === null
            ? 'DAEMON_TIMESTAMP_INVALID'
            : 'DAEMON_STATUS_STALE';
  return {
    ready,
    status: status?.status || 'NOT_REPORTED',
    ageMs,
    maxAgeMs,
    pid,
    processAlive: !processMissing,
    lastCycleExitCode: Number.isFinite(Number(status?.lastCycleExitCode)) ? Number(status.lastCycleExitCode) : null,
    lastCycleDecision: status?.lastCycleDecision || null,
    cycleNeedsHumanReview,
    lastCycleTimedOut: cycleTimedOut,
    reason,
  };
};

export { LIVE_STATUSES };

