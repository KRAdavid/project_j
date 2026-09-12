import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { evaluateReleaseReadiness } from '../beta-app/readiness.mjs';
import { buildTriggerTasks, deriveOperationalSignals, deriveTaskMetadataSignals, deriveTaskSlaSignals, enqueueTriggerTasks, reconcileTriggerQueue, selectActiveTriggerTasks, upsertTriggerInbox } from './trigger-engine.mjs';
import { acquireOperationLock } from './operation-lock.mjs';
import { writeExecutiveReview } from './executive-review.mjs';
import { mergeTriggerApprovalItems } from './autopilot-ledger.mjs';
import { compactTaskQueue } from './task-queue-compaction.mjs';
import { writeCutoverInputManifest } from './cutover-input-manifest.mjs';
import { appendOperationalNotifications, buildOperationalNotifications } from './notification-outbox.mjs';
import { dispatchPendingNotifications, requiresNotificationIncident } from './notification-dispatcher.mjs';
import { auditTaskTimeline } from './task-audit-integrity.mjs';
import { applyApprovedTaskAuditRemediation, buildTaskAuditRemediationPlan, writeTaskAuditRemediationPlan } from './task-audit-remediation.mjs';
import { writeGoalAudit } from './goal-audit.mjs';
import { buildTeamActivityReport, writeTeamActivityReport } from './team-activity-report.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const opsRoot = resolve(root, 'ops');
const teamAutonomyPolicy = JSON.parse(await readFile(resolve(root, 'data', 'team-autonomy-policy.json'), 'utf8'));
const monitorBaseUrl = (process.env.MONITOR_BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const cycleId = `OPS-CYCLE-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const generatedAt = new Date().toISOString();
let operationLock;
try {
  operationLock = await acquireOperationLock(resolve(opsRoot, '.operations-cycle.lock'));
} catch (error) {
  if (error.code === 'OPERATION_ALREADY_RUNNING') {
    console.log(JSON.stringify({ cycleId, decision: 'SKIPPED_ALREADY_RUNNING', guardrail: '동일 운영 사이클 중복 실행을 허용하지 않습니다.' }));
    process.exit(0);
  }
  throw error;
}
process.on('exit', operationLock.releaseSync);

const parseLastJson = (output) => {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
};

const runScript = (script, env = {}, timeout = 30000, args = []) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: opsRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
  });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal || null,
    error: result.error?.message || null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
};

const monitorExecution = runScript('monitor-beta.mjs', { MONITOR_BASE_URL: monitorBaseUrl });
const monitor = parseLastJson(monitorExecution.output) || {
  status: 'INCIDENT',
  baseUrl: monitorBaseUrl,
  error: '모니터링 결과를 JSON으로 해석하지 못했습니다.',
};

// The autopilot runs the evidence suite sequentially. Its deadline must be
// long enough for a real local cycle, while remaining below the supervised
// daemon's 600-second cycle budget so the outer worker can still finalize the
// queue, approvals, notifications, and activity report.
const autopilotTimeoutMs = Math.max(30000, Number(process.env.OPS_CYCLE_AUTOPILOT_TIMEOUT_MS || 480000));
const autopilotExecution = runScript('run-autopilot.mjs', { OPS_CYCLE_LOCK_HELD: 'true' }, autopilotTimeoutMs, ['--claim']);
let latestRun = null;
try {
  latestRun = JSON.parse(await readFile(resolve(opsRoot, 'latest-autopilot-run.json'), 'utf8'));
} catch (error) {
  latestRun = {
    evidence: [{ name: 'autopilot-execution', passed: false, skipped: false, output: error.message }],
    decision: 'BLOCKED',
  };
}
const readiness = await evaluateReleaseReadiness({ environment: process.env.APP_ENV || 'simulation' });
const taskQueuePath = resolve(opsRoot, 'task-queue.json');
let taskQueueSnapshot = JSON.parse(await readFile(taskQueuePath, 'utf8'));
let taskTimelineAudit = await auditTaskTimeline({
  queuePath: taskQueuePath,
  archivePath: resolve(opsRoot, 'task-queue-archive.jsonl'),
  generatedAt,
});
const taskAuditRemediationPlan = buildTaskAuditRemediationPlan({ taskQueue: taskQueueSnapshot, audit: taskTimelineAudit, generatedAt });
await writeTaskAuditRemediationPlan(resolve(opsRoot, 'task-audit-remediation-plan.json'), taskAuditRemediationPlan);
const taskAuditRemediation = await applyApprovedTaskAuditRemediation({
  plan: taskAuditRemediationPlan,
  queuePath: taskQueuePath,
  approvalInboxPath: resolve(opsRoot, 'approval-inbox.json'),
  remediationLogPath: resolve(opsRoot, 'task-audit-remediation.jsonl'),
});
if (taskAuditRemediation.status === 'APPLIED') {
  taskQueueSnapshot = JSON.parse(await readFile(taskQueuePath, 'utf8'));
  taskTimelineAudit = await auditTaskTimeline({
    queuePath: taskQueuePath,
    archivePath: resolve(opsRoot, 'task-queue-archive.jsonl'),
    generatedAt: new Date().toISOString(),
  });
}
// The autopilot is nested inside this cycle. Use a fresh mutation timestamp
// for queue writes so a long-running inner run cannot create a later task that
// is resolved with the cycle start time.
const queueMutationAt = new Date().toISOString();
const executionSignals = autopilotExecution.exitCode === 0 ? [] : [{
  triggerKey: 'QUALITY_GATE_FAILED',
  fingerprint: `autopilot:${autopilotExecution.timedOut ? 'timeout' : 'exit'}:${autopilotExecution.error || 'nonzero'}`,
  source: 'run-autopilot.mjs',
  context: autopilotExecution.error || autopilotExecution.output || '자동 점검 프로세스가 정상 종료되지 않았습니다.',
}];
if (taskTimelineAudit.activeViolationCount > 0) {
  executionSignals.push({
    triggerKey: 'QUALITY_GATE_FAILED',
    fingerprint: 'task-audit:active-timeline',
    source: 'task-audit-integrity',
    context: `활성 업무 ${taskTimelineAudit.activeViolationCount}건에서 시간 순서 불변식 위반이 발견되었습니다.`,
  });
}
if (taskAuditRemediation.status === 'STALE_PLAN') {
  executionSignals.push({
    triggerKey: 'QUALITY_GATE_FAILED',
    fingerprint: 'task-audit:stale-approved-plan',
    source: 'task-audit-remediation',
    context: `H-01 승인 후 원장이 변경되어 감사 정정 계획 적용을 중단했습니다: ${(taskAuditRemediation.staleTaskIds || []).join(', ')}`,
  });
}
const triggerSignals = [
  ...deriveOperationalSignals({ evidence: latestRun.evidence, readiness, monitor }),
  ...deriveTaskMetadataSignals({ taskQueue: taskQueueSnapshot }),
  ...deriveTaskSlaSignals({ taskQueue: taskQueueSnapshot }),
  ...executionSignals,
];
const triggerTasks = buildTriggerTasks({ signals: triggerSignals, generatedAt: queueMutationAt });
const triggerResult = await upsertTriggerInbox(resolve(opsRoot, 'trigger-inbox.json'), triggerTasks, { generatedAt: queueMutationAt });
const activeTriggerTasks = selectActiveTriggerTasks({ currentTasks: triggerTasks, inbox: triggerResult.inbox });
const reconciledTriggerQueue = await reconcileTriggerQueue(
  taskQueuePath,
  new Set(triggerTasks.map((task) => task.fingerprint)),
  { generatedAt: queueMutationAt },
);
const queueResult = await enqueueTriggerTasks(taskQueuePath, activeTriggerTasks, { generatedAt: queueMutationAt });
const triggerApprovalSync = await mergeTriggerApprovalItems(
  resolve(opsRoot, 'approval-inbox.json'),
  activeTriggerTasks,
  { sourceRunId: cycleId, generatedAt: queueMutationAt },
);
const queueCompaction = await compactTaskQueue(taskQueuePath, resolve(opsRoot, 'task-queue-archive.jsonl'), { generatedAt: queueMutationAt });
const parseOutput = (output = '') => {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) { try { return JSON.parse(lines[index]); } catch {} }
  return null;
};
const cutoverInputManifest = await writeCutoverInputManifest({
  readiness,
  stagingPreflight: parseOutput(latestRun.evidence?.find((item) => item.name === 'staging-preflight')?.output) || {},
  githubTargetPreflight: parseOutput(latestRun.evidence?.find((item) => item.name === 'github-target-preflight')?.output) || {},
  sourceRunId: latestRun.runId,
  generatedAt,
});

const cycle = {
  schemaVersion: 'OPS-CYCLE-0.1',
  cycleId,
  generatedAt,
  monitor: { ...monitor, exitCode: monitorExecution.exitCode, signal: monitorExecution.signal, error: monitorExecution.error, timedOut: monitorExecution.timedOut },
  autopilot: { ...parseLastJson(autopilotExecution.output), exitCode: autopilotExecution.exitCode, signal: autopilotExecution.signal, error: autopilotExecution.error, timedOut: autopilotExecution.timedOut },
  readiness: { decision: readiness.decision, missing: readiness.missing },
  automation: {
    triggerSignals: triggerSignals.map(({ triggerKey, fingerprint, source }) => ({ triggerKey, fingerprint, source })),
    newTriggerTaskIds: triggerResult.additions.map((task) => task.id),
    triggerInboxStatus: triggerResult.inbox.status,
    triggerInboxPending: triggerResult.inbox.pending,
    resolvedTriggerTaskIds: reconciledTriggerQueue.resolvedTaskIds,
    enqueuedTriggerTaskIds: queueResult.additions.map((task) => task.id),
    approvalInboxAddedTriggerTaskIds: triggerApprovalSync.additions.map((item) => item.taskId),
    queueCompaction: { archivedCount: queueCompaction.archivedCount, newArchiveRecords: queueCompaction.newArchiveRecords || 0, remainingCount: queueCompaction.remainingCount },
    taskTimelineAudit: {
      status: taskTimelineAudit.status,
      activeViolationCount: taskTimelineAudit.activeViolationCount,
      archiveViolationCount: taskTimelineAudit.archiveViolationCount,
      correctedCount: taskTimelineAudit.correctedCount,
      remainingArchiveViolationCount: taskTimelineAudit.remainingArchiveViolationCount,
    },
    taskAuditRemediation: {
      status: taskAuditRemediation.status,
      planId: taskAuditRemediationPlan.planId,
      requiredApprovalId: taskAuditRemediationPlan.requiredApprovalId,
      actionCount: taskAuditRemediationPlan.actionCount,
      eligibleActionCount: taskAuditRemediationPlan.eligibleActionCount,
      appliedTaskIds: taskAuditRemediation.appliedTaskIds || [],
      staleTaskIds: taskAuditRemediation.staleTaskIds || [],
    },
    cutoverInputManifest: { decision: cutoverInputManifest.decision, missing: cutoverInputManifest.items.filter((item) => !item.current).map((item) => item.id) },
  },
  decision: monitor.status === 'OK' && autopilotExecution.exitCode === 0 && taskTimelineAudit.activeViolationCount === 0 ? 'HUMAN_REVIEW_REQUIRED' : 'INCIDENT_HUMAN_REVIEW_REQUIRED',
  guardrail: '모니터링 사고·품질 게이트 실패·활성 업무 감사 오류 시 AI는 거래·계약·결제·운영 재개를 승인하지 않는다.',
};

await writeFile(resolve(opsRoot, 'latest-ops-cycle.json'), `${JSON.stringify(cycle, null, 2)}\n`, 'utf8');
const markdown = [
  `# 운영 사이클 · ${cycle.cycleId}`,
  '',
  `- 생성시각: ${generatedAt}`,
  `- 모니터링: **${monitor.status}**`,
  `- 자동 실행: **${cycle.autopilot?.decision || '확인 필요'}**`,
  `- 상용 전환: **${readiness.decision}**`,
  `- 자동 생성 업무: **${triggerResult.additions.length}건**, 대기 **${triggerResult.inbox.pending}건**`,
  '',
  '모니터링·품질·릴리스 조건 중 하나라도 안전하지 않으면 H-01 승인 전까지 실제 거래·계약·결제·운영 재개를 수행하지 않는다.',
].join('\n');
await writeFile(resolve(opsRoot, 'latest-ops-cycle.md'), `${markdown}\n`, 'utf8');
const executiveReview = await writeExecutiveReview({ generatedAt });
const notificationResult = await appendOperationalNotifications(
  resolve(opsRoot, 'notification-outbox.jsonl'),
  buildOperationalNotifications({ cycle, review: executiveReview, generatedAt }),
  { generatedAt },
);
const notificationDispatch = await dispatchPendingNotifications({
  outboxPath: resolve(opsRoot, 'notification-outbox.jsonl'),
  environment: process.env.APP_ENV || 'simulation',
});
const notificationIncident = requiresNotificationIncident({ environment: process.env.APP_ENV || 'simulation', status: notificationDispatch.status });
if (notificationIncident) {
  cycle.decision = 'INCIDENT_HUMAN_REVIEW_REQUIRED';
  cycle.guardrail = '외부 운영 알림 채널이 유효하지 않거나 전송에 실패하면 H-01 검토 전까지 운영 재개를 승인하지 않는다.';
}
cycle.automation.notificationOutbox = {
  addedCount: notificationResult.addedCount,
  pendingCount: notificationResult.pendingCount,
  delivery: notificationResult.delivery,
  externalNotificationSent: notificationResult.externalNotificationSent,
  dispatch: {
    status: notificationDispatch.status,
    attemptedCount: notificationDispatch.attemptedCount,
    sentCount: notificationDispatch.sentCount,
    failedCount: notificationDispatch.failedCount,
    externalNotificationSent: notificationDispatch.externalNotificationSent,
    incidentEscalation: notificationIncident,
  },
};
await writeFile(resolve(opsRoot, 'latest-ops-cycle.json'), `${JSON.stringify(cycle, null, 2)}\n`, 'utf8');
// Rebuild the executive packet after notification dispatch so its decision
// surface reflects the final delivery state for H-01.
await writeExecutiveReview({ generatedAt });
await writeGoalAudit({ generatedAt: new Date().toISOString() });
const finalQueue = JSON.parse(await readFile(taskQueuePath, 'utf8'));
const finalApprovalInbox = JSON.parse(await readFile(resolve(opsRoot, 'approval-inbox.json'), 'utf8'));
await writeTeamActivityReport(resolve(opsRoot, 'latest-team-activity.json'), buildTeamActivityReport({
  roster: JSON.parse(await readFile(resolve(root, 'data', 'team-roster.json'), 'utf8')).members,
  tasks: finalQueue.tasks,
  selectedTask: latestRun.selectedTask || null,
  pendingApprovalTaskIds: new Set((finalApprovalInbox.items || []).filter((item) => item.status === 'PENDING').map((item) => item.taskId)),
  readiness,
  cycleId,
  generatedAt: new Date().toISOString(),
  automation: cycle.automation,
  workPacket: latestRun.workPacket || null,
  policy: teamAutonomyPolicy,
}));
console.log(JSON.stringify({ cycleId, decision: cycle.decision, monitor: monitor.status, autopilot: cycle.autopilot?.decision, triggerTasks: triggerResult.inbox.pending }));

if (cycle.decision === 'INCIDENT_HUMAN_REVIEW_REQUIRED') process.exitCode = 1;

