import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendAutopilotRun, mergeTriggerApprovalItems, writeApprovalInbox } from './autopilot-ledger.mjs';
import { evaluateReleaseReadiness } from '../beta-app/readiness.mjs';
import { buildTriggerTasks, deriveOperationalSignals, deriveTaskMetadataSignals, deriveTaskSlaSignals, enqueueTriggerTasks, reconcileTriggerQueue, selectActiveTriggerTasks, upsertTriggerInbox } from './trigger-engine.mjs';
import { acquireOperationLock } from './operation-lock.mjs';
import { claimQueuedTask } from './autopilot-claim.mjs';
import { appendWorkPacket, buildWorkPacket } from './work-packet.mjs';
import { appendPatentDisclosurePacket, buildPatentDisclosurePacket } from './patent-disclosure-packet.mjs';
import { evidenceFingerprint, selectNextTask } from './autopilot-selection.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const queuePath = resolve(root, 'ops', 'task-queue.json');
const reportJsonPath = resolve(root, 'ops', 'latest-autopilot-run.json');
const reportMarkdownPath = resolve(root, 'ops', 'latest-autopilot-run.md');
const historyPath = resolve(root, process.env.AUTOPILOT_HISTORY_PATH || 'ops/autopilot-history.jsonl');
const approvalInboxPath = resolve(root, process.env.AUTOPILOT_APPROVAL_INBOX_PATH || 'ops/approval-inbox.json');
const triggerInboxPath = resolve(root, process.env.AUTOPILOT_TRIGGER_INBOX_PATH || 'ops/trigger-inbox.json');
const workPacketsPath = resolve(root, process.env.AUTOPILOT_WORK_PACKETS_PATH || 'ops/work-packets.jsonl');
const patentPacketsPath = resolve(root, process.env.AUTOPILOT_PATENT_PACKETS_PATH || 'ops/patent-disclosures.jsonl');
const patentTraceability = JSON.parse(await readFile(resolve(root, 'data', 'patent-claim-traceability.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
// Windows CI and local desktop runs can briefly contend with the beta server
// and other Node workers. Keep timeout failures real, but allow a bounded
// 30-second per-test window so a slow PASS is not misclassified as a hang.
const testTimeoutMs = Number(process.env.AUTOPILOT_TEST_TIMEOUT_MS || 30000);
let operationLock = null;
try {
  operationLock = process.env.OPS_CYCLE_LOCK_HELD === 'true'
    ? null
    : await acquireOperationLock(resolve(root, 'ops', '.operations-cycle.lock'));
} catch (error) {
  if (error.code === 'OPERATION_ALREADY_RUNNING') {
    console.log(JSON.stringify({ decision: 'SKIPPED_ALREADY_RUNNING', guardrail: '동일 운영 사이클 중복 실행을 허용하지 않습니다.' }));
    process.exit(0);
  }
  throw error;
}
if (operationLock) process.on('exit', operationLock.releaseSync);

const queue = JSON.parse(await readFile(queuePath, 'utf8'));
const readPacketRecords = async () => {
  const records = new Map();
  try {
    const lines = (await readFile(workPacketsPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const packet = JSON.parse(line);
      if (!packet?.taskId) continue;
      const prior = records.get(packet.taskId) || { packetCount: 0 };
      records.set(packet.taskId, {
        packetCount: prior.packetCount + 1,
        generatedAt: packet.generatedAt || prior.generatedAt || '',
        evidenceFingerprint: packet.evidenceFingerprint || prior.evidenceFingerprint || null,
      });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return records;
};
const packetRecords = await readPacketRecords();
const readPendingApprovalTaskIds = async () => {
  try {
    const inbox = JSON.parse(await readFile(approvalInboxPath, 'utf8'));
    return new Set((inbox.items || []).filter((item) => item.status === 'PENDING').map((item) => item.taskId));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
};
const pendingApprovalTaskIds = await readPendingApprovalTaskIds();

const runNodeTest = (name, script) => {
  const execute = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: testTimeoutMs });
  let result = execute();
  let timedOut = result.error?.code === 'ETIMEDOUT';
  let output = `${result.stdout || ''}${result.stderr || ''}${timedOut ? `\nTIMEOUT after ${testTimeoutMs}ms` : ''}`.trim();
  const transientServerStartupFailure = !timedOut && result.status !== 0 && /server unavailable/i.test(output);
  let retryCount = 0;
  if (transientServerStartupFailure) {
    retryCount = 1;
    result = execute();
    timedOut = result.error?.code === 'ETIMEDOUT';
    output = `${result.stdout || ''}${result.stderr || ''}${timedOut ? `\nTIMEOUT after ${testTimeoutMs}ms` : ''}`.trim();
  }
  if (result.status !== 0 || timedOut) {
    console.error(JSON.stringify({ component: 'autopilot', test: name, command: `node ${script}`, status: result.status, timedOut, output }));
  }
  return {
    name,
    passed: result.status === 0 && !timedOut,
    skipped: result.status === 0 && /\bSKIP\b/.test(output),
    timedOut,
    retryCount,
    command: `node ${script}`,
    output,
  };
};
const inventoryEvidence = runNodeTest('inventory-state-machine', 'beta-app/test-inventory-ledger.mjs');
const materialMasterEvidence = runNodeTest('material-master', 'beta-app/test-material-master.mjs');
const specCompilerEvidence = runNodeTest('spec-compiler', 'beta-app/test-spec-compiler.mjs');
const tradeTermsEvidence = runNodeTest('trade-terms', 'beta-app/test-trade-terms.mjs');
const priceEvidence = runNodeTest('price-index', 'beta-app/test-price-index.mjs');
const priceFeedEvidence = runNodeTest('price-feed', 'beta-app/test-price-feed.mjs');
const evidenceVerifierEvidence = runNodeTest('evidence-verifier', 'beta-app/test-evidence-verifier.mjs');
const evidenceRegistryEvidence = runNodeTest('evidence-registry', 'beta-app/test-evidence-registry.mjs');
const documentStorageEvidence = runNodeTest('document-storage', 'beta-app/test-document-storage.mjs');
const eventBrokerEvidence = runNodeTest('event-broker', 'beta-app/test-event-broker.mjs');
const sseEvidence = runNodeTest('sse-integration', 'beta-app/test-sse-integration.mjs');
const sseHeartbeatEvidence = runNodeTest('sse-heartbeat', 'beta-app/test-sse-heartbeat.mjs');
const transactionEvidence = runNodeTest('transaction-integrity', 'beta-app/test-trade-engine.mjs');
const snapshotIntegrityEvidence = runNodeTest('snapshot-integrity', 'beta-app/test-snapshot-integrity.mjs');
const lifecycleEvidence = runNodeTest('trade-lifecycle', 'beta-app/test-trade-lifecycle.mjs');
const marketBoardLifecycleEvidence = runNodeTest('market-board-lifecycle', 'beta-app/test-market-board-lifecycle.mjs');
const persistenceStoreEvidence = (() => {
  const result = spawnSync(process.execPath, ['--experimental-sqlite', 'beta-app/test-persistence-store.mjs'], { cwd: root, encoding: 'utf8', timeout: testTimeoutMs });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    name: 'persistence-store-recovery',
    passed: result.status === 0 && !timedOut,
    timedOut,
    command: `node --experimental-sqlite beta-app/test-persistence-store.mjs`,
    output: `${result.stdout || ''}${result.stderr || ''}${timedOut ? `\nTIMEOUT after ${testTimeoutMs}ms` : ''}`.trim(),
  };
})();
const serverPersistenceEvidence = (() => {
  const result = spawnSync(process.execPath, ['--experimental-sqlite', 'beta-app/test-server-persistence.mjs'], { cwd: root, encoding: 'utf8', timeout: testTimeoutMs });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    name: 'server-persistence-recovery',
    passed: result.status === 0 && !timedOut,
    timedOut,
    command: `node --experimental-sqlite beta-app/test-server-persistence.mjs`,
    output: `${result.stdout || ''}${result.stderr || ''}${timedOut ? `\nTIMEOUT after ${testTimeoutMs}ms` : ''}`.trim(),
  };
})();
const productionFailClosedEvidence = runNodeTest('production-fail-closed', 'beta-app/test-production-fail-closed.mjs');
const postgresIntegrationEvidence = runNodeTest('postgres-integration', 'beta-app/test-postgres-integration.mjs');
const postgresDomainAdapterEvidence = runNodeTest('postgres-domain-adapter', 'beta-app/test-postgres-domain-adapter.mjs');
const postgresDomainAdapterAcceptEvidence = runNodeTest('postgres-domain-adapter-accept', 'beta-app/test-postgres-domain-adapter-accept.mjs');
const postgresDomainAdapterSpecLockEvidence = runNodeTest('postgres-domain-adapter-spec-lock', 'beta-app/test-postgres-domain-adapter-spec-lock.mjs');
const postgresDomainAdapterLotEvidence = runNodeTest('postgres-domain-adapter-lot', 'beta-app/test-postgres-domain-adapter-lot.mjs');
const postgresDomainAdapterEvidenceWorkflow = runNodeTest('postgres-domain-adapter-evidence', 'beta-app/test-postgres-domain-adapter-evidence.mjs');
const atomicInspectionPriceEvidence = runNodeTest('atomic-inspection-price', 'beta-app/test-postgres-domain-adapter-atomic-inspect.mjs');
const lotReviewGateEvidence = runNodeTest('lot-review-gate', 'beta-app/test-postgres-domain-adapter-lot-review-gate.mjs');
const domainReconciliationEvidence = runNodeTest('domain-reconciliation', 'beta-app/test-domain-reconciliation.mjs');
const postgresConcurrentReservationEvidence = runNodeTest('postgres-concurrent-reservation', 'beta-app/test-postgres-concurrent-reservation.mjs');
const postgresConcurrencyContractEvidence = runNodeTest('postgres-concurrency-contract', 'ops/test-postgres-concurrency-contract.mjs');
const postgresOrderIdempotencyEvidence = runNodeTest('postgres-order-idempotency', 'beta-app/test-postgres-order-idempotency.mjs');
const postgresAcceptIdempotencyEvidence = runNodeTest('postgres-accept-idempotency', 'beta-app/test-postgres-accept-idempotency.mjs');
const postgresCommandIdempotencyEvidence = runNodeTest('postgres-command-idempotency', 'beta-app/test-postgres-command-idempotency.mjs');
const postgresActionIdempotencyEvidence = runNodeTest('postgres-action-idempotency', 'beta-app/test-postgres-action-idempotency.mjs');
const productionDomainPathEvidence = runNodeTest('production-domain-path', 'ops/validate-production-domain-path.mjs');
const postgresRecoveryEvidence = runNodeTest('postgres-backup-restore-drill', 'ops/postgres-backup-restore-drill.mjs');
const monitoringEvidence = runNodeTest('monitoring', 'ops/test-monitoring.mjs');
const incidentLedgerEvidence = runNodeTest('incident-ledger', 'ops/test-incident-ledger.mjs');
const incidentRehearsalEvidence = runNodeTest('incident-rehearsal', 'ops/test-incident-rehearsal.mjs');
const monitoringConfigEvidence = runNodeTest('monitoring-config', 'ops/validate-monitoring-config.mjs');
const readinessEvidence = runNodeTest('release-readiness-api', 'beta-app/test-readiness.mjs');
const apiAuthorizationEvidence = runNodeTest('api-authorization', 'beta-app/test-api-authorization.mjs');
const lotOnboardingEvidence = runNodeTest('lot-onboarding-gate', 'beta-app/test-lot-onboarding.mjs');
const snapshotProjectionEvidence = runNodeTest('organization-snapshot-projection', 'beta-app/test-snapshot-projection.mjs');
const postgresCutoverPlanEvidence = runNodeTest('postgres-cutover-plan', 'ops/validate-postgres-cutover-plan.mjs');
const uiContractEvidence = runNodeTest('ui-contract', 'ops/validate-ui-contract.mjs');
const approvalSyncEvidence = runNodeTest('approval-inbox-sync', 'ops/test-approval-sync.mjs');
const operationsDaemonEvidence = runNodeTest('operations-daemon-contract', 'ops/test-ops-daemon.mjs');
const githubGovernanceEvidence = runNodeTest('github-governance-contract', 'ops/test-github-governance.mjs');
const githubTargetPreflightEvidence = runNodeTest('github-target-preflight', 'ops/test-github-target-preflight.mjs');
const stagingContractEvidence = runNodeTest('staging-contract', 'ops/test-staging-contract.mjs');
const stagingPreflightEvidence = runNodeTest('staging-preflight', 'ops/test-staging-preflight.mjs');
const postgresApprovalEvidence = runNodeTest('postgres-approval-adapter', 'beta-app/test-postgres-approval-adapter.mjs');
const supplierVerificationEvidence = runNodeTest('supplier-verification-gate', 'beta-app/test-supplier-verification-gate.mjs');
const supplierEligibilityEvidence = runNodeTest('supplier-eligibility-contract', 'beta-app/test-supplier-eligibility.mjs');
const teamRosterEvidence = runNodeTest('team-roster', 'ops/validate-team-roster.mjs');
const taskOwnershipEvidence = runNodeTest('task-ownership', 'ops/validate-task-ownership.mjs');
const patentTraceabilityEvidence = runNodeTest('patent-traceability', 'ops/validate-patent-traceability.mjs');
const patentPriorArtEvidence = runNodeTest('patent-prior-art', 'ops/test-patent-prior-art.mjs');
const workPacketEvidence = runNodeTest('work-packet', 'ops/test-work-packet.mjs');
const patentDisclosureEvidence = runNodeTest('patent-disclosure-packet', 'ops/test-patent-disclosure-packet.mjs');
const readinessDiagnosticsEvidence = runNodeTest('readiness-diagnostics', 'beta-app/test-readiness-diagnostics.mjs');
const executiveReviewEvidence = runNodeTest('executive-review', 'ops/test-executive-review.mjs');
const approvalSlaEvidence = runNodeTest('approval-sla', 'ops/test-approval-sla.mjs');
const notificationOutboxEvidence = runNodeTest('notification-outbox', 'ops/test-notification-outbox.mjs');
const serverLauncherEvidence = runNodeTest('server-launcher', 'ops/test-server-launcher.mjs');
const taskQueueCompactionEvidence = runNodeTest('task-queue-compaction', 'ops/test-task-queue-compaction.mjs');
const daemonLivenessEvidence = runNodeTest('daemon-liveness', 'ops/test-daemon-liveness.mjs');
const cutoverInputManifestEvidence = runNodeTest('cutover-input-manifest', 'ops/test-cutover-input-manifest.mjs');
const evidence = [
  { name: 'task-queue-json', passed: Array.isArray(queue.tasks) && queue.tasks.length > 0, command: 'JSON parse' },
  inventoryEvidence,
  materialMasterEvidence,
  specCompilerEvidence,
  tradeTermsEvidence,
  priceEvidence,
  priceFeedEvidence,
  evidenceVerifierEvidence,
  evidenceRegistryEvidence,
  documentStorageEvidence,
  eventBrokerEvidence,
  sseEvidence,
  sseHeartbeatEvidence,
  transactionEvidence,
  snapshotIntegrityEvidence,
  lifecycleEvidence,
  marketBoardLifecycleEvidence,
  persistenceStoreEvidence,
  serverPersistenceEvidence,
  productionFailClosedEvidence,
  postgresIntegrationEvidence,
  postgresDomainAdapterEvidence,
  postgresDomainAdapterAcceptEvidence,
  postgresDomainAdapterSpecLockEvidence,
  postgresDomainAdapterLotEvidence,
  postgresDomainAdapterEvidenceWorkflow,
  atomicInspectionPriceEvidence,
  lotReviewGateEvidence,
  domainReconciliationEvidence,
  postgresConcurrentReservationEvidence,
  postgresConcurrencyContractEvidence,
  postgresOrderIdempotencyEvidence,
  postgresAcceptIdempotencyEvidence,
  postgresCommandIdempotencyEvidence,
  postgresActionIdempotencyEvidence,
  productionDomainPathEvidence,
  postgresRecoveryEvidence,
  monitoringEvidence,
  incidentLedgerEvidence,
  incidentRehearsalEvidence,
  monitoringConfigEvidence,
  readinessEvidence,
  apiAuthorizationEvidence,
  lotOnboardingEvidence,
  snapshotProjectionEvidence,
  postgresCutoverPlanEvidence,
  uiContractEvidence,
  approvalSyncEvidence,
  operationsDaemonEvidence,
  githubGovernanceEvidence,
  githubTargetPreflightEvidence,
  stagingContractEvidence,
  stagingPreflightEvidence,
  postgresApprovalEvidence,
  supplierVerificationEvidence,
  supplierEligibilityEvidence,
  teamRosterEvidence,
  taskOwnershipEvidence,
  patentTraceabilityEvidence,
  patentPriorArtEvidence,
  workPacketEvidence,
  patentDisclosureEvidence,
  readinessDiagnosticsEvidence,
  executiveReviewEvidence,
  approvalSlaEvidence,
  notificationOutboxEvidence,
  serverLauncherEvidence,
  taskQueueCompactionEvidence,
  daemonLivenessEvidence,
  cutoverInputManifestEvidence,
  runNodeTest('persistence-schema', 'ops/validate-persistence-schema.mjs'),
  runNodeTest('price-source-contract', 'ops/validate-price-source-contract.mjs'),
  runNodeTest('authorization-policy', 'ops/validate-authorization-policy.mjs'),
  runNodeTest('release-readiness', 'ops/validate-release-readiness.mjs'),
  runNodeTest('shadow-pilot-plan', 'ops/test-shadow-pilot-plan.mjs'),
  runNodeTest('material-master-contract', 'ops/validate-material-master-contract.mjs'),
  runNodeTest('postgres-domain-adapter-contract', 'ops/validate-postgres-domain-adapter-contract.mjs'),
  runNodeTest('autopilot-ledger', 'ops/test-autopilot-ledger.mjs'),
  runNodeTest('trigger-engine', 'ops/test-trigger-engine.mjs'),
  runNodeTest('approval-store', 'ops/test-approval-store.mjs'),
  runNodeTest('operation-lock', 'ops/test-operation-lock.mjs'),
  runNodeTest('autopilot-claim', 'ops/test-autopilot-claim.mjs'),
  runNodeTest('autopilot-selection', 'ops/test-autopilot-selection.mjs'),
  runNodeTest('shadow-pilot-execution', 'ops/test-shadow-pilot-integration.mjs'),
];

const readiness = await evaluateReleaseReadiness({ environment: process.env.APP_ENV || 'simulation' });
const triggerSignals = [
  ...deriveOperationalSignals({ evidence, readiness }),
  ...deriveTaskMetadataSignals({ taskQueue: queue }),
  ...deriveTaskSlaSignals({ taskQueue: queue }),
];
const triggerTasks = buildTriggerTasks({ signals: triggerSignals, generatedAt: new Date().toISOString() });
const reconciledQueue = await reconcileTriggerQueue(queuePath, new Set(triggerTasks.map((task) => task.fingerprint)), { generatedAt: new Date().toISOString() });
queue.tasks = reconciledQueue.queue.tasks;
const currentEvidenceFingerprint = evidenceFingerprint(evidence);
const selected = selectNextTask({
  tasks: queue.tasks,
  packetRecords,
  pendingApprovalTaskIds,
  currentEvidenceFingerprint,
});
const selectedTask = selected.task;
const selectionType = selected.selectionType;

const run = {
  runId: `AUTOPILOT-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
  generatedAt: new Date().toISOString(),
  mode: args.has('--claim') ? 'claim' : 'review-packet',
  selectedTask,
  queueSummary: {
    queued: queue.tasks.filter((task) => task.status === 'queued').length,
    working: queue.tasks.filter((task) => task.status === 'working').length,
    review: queue.tasks.filter((task) => task.status === 'review').length,
    humanApproval: queue.tasks.filter((task) => task.humanGate === 'approval').length,
  },
  selectionType,
  evidence,
  decision: selectedTask && evidence.every((item) => item.passed) ? 'HUMAN_REVIEW_REQUIRED' : 'BLOCKED',
  authority: {
    canPrepare: true,
    canRunTests: true,
    canWriteReviewPacket: true,
    canApproveTrade: false,
    canApproveContract: false,
    canReleasePayment: false,
  },
  nextActions: selectedTask ? [
    selectionType === 'queued' ? `주담당 ${selectedTask.ownerAi}가 '${selectedTask.objective}'를 시작한다.` : `주담당 ${selectedTask.ownerAi}가 '${selectedTask.objective}'의 다음 조치를 수행한다.`,
    `검토자 ${selectedTask.reviewers.join(', ')}가 산출물과 위험을 교차검토한다.`,
    'H-01이 승인·수정·보류 중 하나를 결정하기 전까지 실제 거래·계약·정산에 사용하지 않는다.',
  ] : ['대기 중인 업무가 없습니다. H-01에게 다음 목표 등록을 요청합니다.'],
};

const triggerResult = await upsertTriggerInbox(triggerInboxPath, triggerTasks, { generatedAt: run.generatedAt });
const activeTriggerTasks = selectActiveTriggerTasks({ currentTasks: triggerTasks, inbox: triggerResult.inbox });
const queueResult = await enqueueTriggerTasks(queuePath, activeTriggerTasks, { generatedAt: run.generatedAt });
run.automation = {
  triggerSignals: triggerSignals.map(({ triggerKey, fingerprint, source, context }) => ({ triggerKey, fingerprint, source, context })),
  triggerTasks,
  newTriggerTaskIds: triggerResult.additions.map((task) => task.id),
  triggerInboxStatus: triggerResult.inbox.status,
  triggerInboxPending: triggerResult.inbox.pending,
  enqueuedTriggerTaskIds: queueResult.additions.map((task) => task.id),
};

if (args.has('--claim')) {
  const claim = claimQueuedTask(selectedTask, selectionType, { claimedAt: run.generatedAt });
  if (claim.claimed) await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

// First rebuild the current-run approval packet, then merge every still-active
// trigger task so no unresolved automated task is invisible to H-01.
await writeApprovalInbox(approvalInboxPath, run);
const triggerApprovalSync = await mergeTriggerApprovalItems(approvalInboxPath, activeTriggerTasks, { sourceRunId: run.runId, generatedAt: run.generatedAt });
run.automation.approvalInboxPending = triggerApprovalSync.inbox.items.filter((item) => item.status === 'PENDING').length;
run.automation.approvalInboxAddedTriggerTaskIds = triggerApprovalSync.additions.map((item) => item.taskId);
run.workPacket = buildWorkPacket({ run, generatedAt: run.generatedAt });
await appendWorkPacket(workPacketsPath, run.workPacket);
run.patentPacket = buildPatentDisclosurePacket({ traceability: patentTraceability, run, generatedAt: run.generatedAt });
await appendPatentDisclosurePacket(patentPacketsPath, run.patentPacket);

const markdown = [
  `# AI TF 자동 실행 패킷 · ${run.runId}`,
  '',
  `- 생성시각: ${run.generatedAt}`,
  `- 결정: **${run.decision}**`,
  `- 모드: ${run.mode}`,
  '',
  '## 선택된 업무',
  selectedTask ? `- **${selectedTask.id}** · ${selectedTask.objective}` : '- 대기 업무 없음',
  selectedTask ? `- 주담당: ${selectedTask.ownerAi}` : '',
  selectedTask ? `- 검토자: ${selectedTask.reviewers.join(', ')}` : '',
  selectedTask ? `- 인간 게이트: ${selectedTask.humanGate}` : '',
  run.workPacket ? `- 작업 패킷: **${run.workPacket.packetId}** · ${run.workPacket.status} · 담당 ${run.workPacket.ownerAi || '없음'}` : '',
  run.patentPacket ? `- BM 특허 설명 패킷: **${run.patentPacket.packetId}** · 변리사 검토 전용` : '',
  '',
  '## 자동 트리거 업무',
  `- 감지 신호: ${run.automation.triggerSignals.length}건`,
  `- 신규 생성: ${run.automation.newTriggerTaskIds.length}건`,
  `- 대기 상태: ${run.automation.triggerInboxStatus} (${run.automation.triggerInboxPending}건)`,
  '',
  '## 실행 증거',
  ...evidence.map((item) => `- ${item.skipped ? 'SKIP' : item.passed ? 'PASS' : 'FAIL'} · ${item.name}${item.output ? ` · ${item.output}` : ''}`),
  '',
  '## 다음 조치',
  ...run.nextActions.map((action) => `1. ${action}`),
  '',
  '## 권한 경계',
  '- AI는 분석·테스트·검토 패킷 작성만 수행합니다.',
  '- 실제 거래 체결·계약 확정·지급·환불·분쟁 종결은 자동 수행하지 않습니다.',
].join('\n');

await writeFile(reportJsonPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
await writeFile(reportMarkdownPath, `${markdown}\n`, 'utf8');
await appendAutopilotRun(historyPath, run);
if (run.decision === 'BLOCKED') {
  console.error(JSON.stringify({
    component: 'autopilot',
    decision: run.decision,
    selectedTaskId: selectedTask?.id || null,
    failedEvidence: evidence.filter((item) => !item.passed).map((item) => ({
      name: item.name,
      command: item.command,
      output: item.output,
    })),
  }));
}
console.log(JSON.stringify({ runId: run.runId, decision: run.decision, taskId: selectedTask?.id || null }));

if (run.decision === 'BLOCKED') process.exitCode = 1;

