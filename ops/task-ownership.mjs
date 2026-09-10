import { readFile } from 'node:fs/promises';

const TERMINAL_STATUSES = new Set(['done', 'rejected', 'resolved', 'approved']);
const ALLOWED_STATUSES = new Set(['queued', 'working', 'review', ...TERMINAL_STATUSES]);

export const buildTeamLabels = (roster) => new Map(
  roster.members.map((member) => [`${member.id} ${member.name}`, member]),
);

export const validateTaskQueue = ({ roster, queue }) => {
  const errors = [];
  if (roster?.humanApprovalPrincipal !== 'H-01') errors.push('human approval principal must be H-01');
  if (!Array.isArray(queue?.tasks) || queue.tasks.length === 0) {
    errors.push('task queue must contain at least one task');
    return errors;
  }

  const labels = buildTeamLabels(roster);
  const ids = new Set();
  for (const task of queue.tasks) {
    if (!task?.id || ids.has(task.id)) errors.push(`duplicate or missing task id: ${task?.id || '(missing)'}`);
    ids.add(task?.id);
    if (!task?.objective) errors.push(`${task?.id || '(missing)'}: objective is required`);
    if (!ALLOWED_STATUSES.has(task?.status)) errors.push(`${task?.id || '(missing)'}: invalid status`);
    const owner = labels.get(task?.ownerAi);
    if (!owner) errors.push(`${task?.id || '(missing)'}: owner is not in team roster`);
    else if (owner.kind !== 'AI' || owner.autonomy !== 'ANALYZE_PREPARE') {
      errors.push(`${task.id}: owner must be an analysis/prepare AI`);
    }
    if (!Array.isArray(task?.reviewers) || task.reviewers.length === 0) {
      errors.push(`${task?.id || '(missing)'}: at least one reviewer is required`);
    } else {
      for (const reviewerLabel of task.reviewers) {
        const reviewer = labels.get(reviewerLabel);
        if (!reviewer) errors.push(`${task.id}: reviewer is not in team roster: ${reviewerLabel}`);
        else if (reviewer.kind !== 'AI' || reviewer.autonomy !== 'ANALYZE_PREPARE') {
          errors.push(`${task.id}: reviewer must be an analysis/prepare AI: ${reviewerLabel}`);
        }
      }
    }
    if (task?.humanGate !== 'approval') errors.push(`${task?.id || '(missing)'}: humanGate must be approval`);
    if (TERMINAL_STATUSES.has(task?.status) && task?.humanGate !== 'approval') {
      errors.push(`${task.id}: terminal task cannot bypass the human gate`);
    }
  }
  return errors;
};

export const readTaskOwnershipInputs = async ({ rosterPath, queuePath }) => ({
  roster: JSON.parse(await readFile(rosterPath, 'utf8')),
  queue: JSON.parse(await readFile(queuePath, 'utf8')),
});
