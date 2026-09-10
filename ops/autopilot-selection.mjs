import { createHash } from 'node:crypto';

const riskRank = { critical: 0, high: 1, medium: 2, low: 3 };
const statusRank = { queued: 0, working: 1, review: 2 };

const normalizeEvidenceOutput = (output = '') => String(output)
  .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
  .replace(/\b(?:AUTOPILOT|OPS-CYCLE)-[A-Za-z0-9:_|.-]+\b/g, '<run-id>')
  .replace(/\b(?:elapsedMs|durationMs|timeoutMs)=\d+\b/g, (value) => `${value.split('=')[0]}=<duration>`)
  .replace(/("(?:checkedAt|generatedAt|createdAt|updatedAt|claimedAt|lastRecheckedAt)"\s*:\s*)"[^"]*"/g, '$1"<timestamp>"')
  .replace(/(\b(?:checkedAt|generatedAt|createdAt|updatedAt|claimedAt|lastRecheckedAt)\s*:\s*)[^,}\n]+/g, '$1<timestamp>');

export const evidenceFingerprint = (evidence = []) => {
  const canonical = (Array.isArray(evidence) ? evidence : []).map((item) => ({
    name: item?.name || null,
    passed: Boolean(item?.passed),
    skipped: Boolean(item?.skipped),
    output: normalizeEvidenceOutput(item?.output || ''),
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

const compareText = (left, right) => String(left || '').localeCompare(String(right || ''), 'en');

/**
 * Selects the next safe AI work item.
 *
 * A task with an unchanged evidence packet already waiting for H-01 is not
 * selected again. This makes repeated daemon cycles idempotent while still
 * allowing a changed environment/evidence set to create a fresh review packet.
 */
export const selectNextTask = ({
  tasks = [],
  packetRecords = new Map(),
  pendingApprovalTaskIds = new Set(),
  currentEvidenceFingerprint,
} = {}) => {
  const candidates = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => Object.hasOwn(statusRank, task?.status))
    .filter((task) => {
      const prior = packetRecords.get(task.id);
      const waitingForHuman = pendingApprovalTaskIds.has(task.id)
        && prior
        && prior.evidenceFingerprint
        && prior.evidenceFingerprint === currentEvidenceFingerprint;
      return !waitingForHuman;
    })
    .sort((a, b) => {
      const statusDelta = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (statusDelta) return statusDelta;
      const aPackets = packetRecords.get(a.id)?.packetCount || 0;
      const bPackets = packetRecords.get(b.id)?.packetCount || 0;
      if (aPackets !== bPackets) return aPackets - bPackets;
      const riskDelta = (riskRank[a.risk] ?? 9) - (riskRank[b.risk] ?? 9);
      if (riskDelta) return riskDelta;
      const aLast = packetRecords.get(a.id)?.generatedAt || '';
      const bLast = packetRecords.get(b.id)?.generatedAt || '';
      const lastDelta = compareText(aLast, bLast);
      if (lastDelta) return lastDelta;
      return compareText(a.id, b.id);
    });
  const task = candidates[0] || null;
  return {
    task,
    selectionType: task ? (task.status === 'queued' ? 'queued' : task.status === 'working' ? 'working-follow-up' : 'human-review') : 'none',
  };
};

