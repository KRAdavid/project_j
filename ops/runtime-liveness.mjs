import { evaluateDaemonLiveness } from './daemon-liveness.mjs';

export const isProcessAlive = (pid, processProbe = process.kill.bind(process)) => {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) return false;
  try {
    processProbe(normalizedPid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Project a persisted runtime record only after checking the process that owns it.
 * Persisted status is retained as reportedStatus for auditability; it is never
 * presented as live when the PID or heartbeat is invalid.
 */
export const projectRuntimeLiveness = (status = {}, { now = Date.now(), maxAgeMs, processAlive } = {}) => {
  const alive = typeof processAlive === 'boolean' ? processAlive : isProcessAlive(status.pid);
  const liveness = evaluateDaemonLiveness(status, {
    now,
    maxAgeMs,
    processAlive: alive,
  });
  const projectedStatus = liveness.ready
    ? status.status || 'NOT_REPORTED'
    : liveness.cycleNeedsHumanReview
      ? 'REVIEW_REQUIRED'
      : 'STALE';
  return {
    ...status,
    reportedStatus: status.status || 'NOT_REPORTED',
    status: projectedStatus,
    liveness,
  };
};

