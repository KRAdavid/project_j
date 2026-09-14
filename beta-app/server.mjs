import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradeEngine, TradeRuleError } from './trade-engine.mjs';
import { materialMasterSnapshot, resolveMaterial, searchMaterials } from './material-master.mjs';
import { loadEvidencePolicy } from './evidence-verifier.mjs';
import { SseEventBroker } from './event-broker.mjs';
import { EvidenceRegistry, EvidenceRegistryError } from './evidence-registry.mjs';
import { persistenceStatus, assertProductionCutover } from './persistence-mode.mjs';
import { createPersistenceStore } from './persistence-store.mjs';
import { authorize, AuthorizationError, loadAuthorizationPolicy, projectEvidence, projectSnapshot, resolvePrincipal } from './authorization.mjs';
import { PriceFeed } from './price-feed.mjs';
import { assertDocumentSignature, createDocumentStorage } from './document-storage.mjs';
import { evaluateReleaseReadiness } from './readiness.mjs';
import { compileSpecDraft, SpecCompilerError } from './spec-compiler.mjs';
import { ApprovalStoreError, decideApproval } from '../ops/approval-store.mjs';
import { acknowledgeOperationalNotification, latestOperationalNotifications, NotificationOutboxError } from '../ops/notification-outbox.mjs';
import { validateTaskQueue } from '../ops/task-ownership.mjs';
import { mapOrder, mapTrade, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';
import { buildMarketBoard } from './market-board.mjs';
import { evaluateTaskSla } from '../ops/task-sla.mjs';
import { compileGoal } from '../ops/goal-compiler.mjs';
import { buildApprovalDecisionGuide } from '../ops/executive-review.mjs';
import { projectRuntimeLiveness } from '../ops/runtime-liveness.mjs';
import { TaskApprovalSyncError, syncTaskApproval } from '../ops/task-approval-sync.mjs';
import { createSimulationSupplierRegistration, evaluateSupplierAiPrecheck, validateKoreanBusinessRegistrationNumber } from './supplier-registration.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const opsRoot = resolve(process.env.OPS_ROOT || resolve(root, '..', 'ops'));
const approvalLogPath = resolve(opsRoot, 'approval-decisions.jsonl');
const notificationOutboxPath = resolve(opsRoot, 'notification-outbox.jsonl');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const environment = process.env.APP_ENV || 'simulation';
if (environment === 'production') {
  const cutover = assertProductionCutover({
    databaseUrl: process.env.DATABASE_URL,
    schemaApplied: process.env.PERSISTENCE_SCHEMA_APPLIED === 'true',
    backupDrillPassed: process.env.BACKUP_DRILL_PASSED === 'true',
    isolationVerified: process.env.TRANSACTION_ISOLATION_VERIFIED === 'true',
    auditPolicyApplied: process.env.AUDIT_POLICY_APPLIED === 'true',
    objectStorageReady: process.env.OBJECT_STORAGE_READY === 'true',
    evidenceStoreReady: process.env.EVIDENCE_STORE_READY === 'true',
    authProviderReady: process.env.AUTH_PROVIDER_READY === 'true',
    authJwtSecret: process.env.AUTH_JWT_SECRET,
    authJwtIssuer: process.env.AUTH_JWT_ISSUER,
    authJwtAudience: process.env.AUTH_JWT_AUDIENCE,
    postgresDomainAdapterReady: process.env.POSTGRES_DOMAIN_ADAPTER_READY === 'true',
    postgresDomainApiReady: process.env.POSTGRES_DOMAIN_API_READY === 'true',
    postgresDomainReconciliationVerified: process.env.POSTGRES_DOMAIN_RECONCILIATION_VERIFIED === 'true',
  });
  if (!cutover.ready || process.env.PERSISTENCE_MODE !== 'postgresql') throw new Error('상용 모드 필수 원장·복구·감사 검증이 완료되지 않아 서버를 시작하지 않습니다.');
}
const persistenceStore = await createPersistenceStore({
  mode: process.env.PERSISTENCE_MODE || 'memory',
  filePath: process.env.PERSISTENCE_FILE || undefined,
});
const runtimeDataStatus = persistenceStore.mode === 'postgresql' ? 'LIVE_POSTGRESQL_LEDGER' : 'SIMULATED_BACKEND';
const engine = new TradeEngine(await persistenceStore.load());
const domainAdapter = persistenceStore.domainAdapter || null;
const SIMULATION_VERIFIED_SUPPLIER_ORG = 'SIM-SUPPLIER-ORG';
const simulationSupplierVerificationRequests = new Map();
const simulationSupplierRegistrations = new Map();
const simulationSupplierRegistrationOwners = new Map();
const simulationBusinessAccounts = new Map();
const simulationSupplierPrechecks = new Map();
const normalizeSupplierPrecheckInput = (input = {}) => ({
  reviewScope: String(input.reviewScope || 'SUPPLY_OFFER').trim().toUpperCase(),
  material: String(input.material || '').trim(),
  coaDocumentNumber: String(input.coaDocumentNumber || '').trim(),
  coaFileName: String(input.coaFileName || '').trim(),
  coaFileSize: Number(input.coaFileSize || 0),
  coaFileSha256: String(input.coaFileSha256 || '').trim().toLowerCase(),
  coaStorageRef: String(input.coaStorageRef || '').trim(),
  inventoryQuantity: Number(input.inventoryQuantity || 0),
  unit: String(input.unit || '').trim().toUpperCase(),
  expiry: String(input.expiry || '').trim(),
  priceTiers: (Array.isArray(input.priceTiers) ? input.priceTiers : [])
    .map((tier) => ({ quantity: Number(tier?.quantity || 0), price: Number(tier?.price || 0) }))
    .sort((a, b) => a.quantity - b.quantity || a.price - b.price),
});
const safeSupplierDocumentFileName = (fileName) => String(fileName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'coa-document';
const supplierPrecheckStorageKey = ({ organizationId, fileName, contentSha256 }) => `supplier-prechecks/${organizationId}/${contentSha256}/${safeSupplierDocumentFileName(fileName)}`;
const supplierPrecheckFingerprint = (input = {}) => createHash('sha256').update(JSON.stringify(normalizeSupplierPrecheckInput(input))).digest('hex');
const eventBroker = new SseEventBroker({ heartbeatPayload: { dataStatus: runtimeDataStatus } });
const evidenceRegistry = new EvidenceRegistry({ snapshot: await persistenceStore.loadEvidence() });
const documentStorage = createDocumentStorage({ environment, persistenceMode: persistenceStore.mode });
const authorizationPolicy = await loadAuthorizationPolicy();
const priceFeed = new PriceFeed({ publicationApproved: process.env.PRICE_SOURCE_APPROVED === 'true', approvalRef: process.env.PRICE_SOURCE_APPROVAL_REF });
await priceFeed.restore(await persistenceStore.loadPriceObservations());

const readOptionalJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};

const readOptionalJsonl = async (path) => {
  try {
    const raw = await readFile(path, 'utf8');
    return { records: raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)), parseError: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], parseError: null };
    return { records: [], parseError: error.message };
  }
};

const securityHeaders = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
});

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
};

const simulationSupplierEligibility = (principal) => {
  const verified = principal.organizationId === SIMULATION_VERIFIED_SUPPLIER_ORG;
  const registration = simulationSupplierRegistrations.get(principal.organizationId) || null;
  const request = simulationSupplierVerificationRequests.get(principal.organizationId) || null;
  return {
    organizationId: principal.organizationId,
    organizationName: verified ? '시뮬레이션 공급기업 A' : registration?.legalName || null,
    organizationExists: verified || Boolean(registration) || Boolean(request),
    organizationRegistered: verified || Boolean(registration),
    organizationVerified: verified,
    activeSupplierMembership: verified || Boolean(registration),
    eligibleToSubmitLot: verified,
    reasons: verified ? [] : registration
      ? ['사업자번호 확인으로 공급자 계정이 자동 등록되었습니다.', 'COA·SDS·TDS·로트추적·재고 증빙 검증 전에는 매물 등록이 차단됩니다.']
      : ['시뮬레이션 조직은 사전 검증된 공급기업이 아닙니다.', ...(request ? ['검증 요청이 H-01 검토를 기다리고 있습니다.'] : [])],
    latestRegistration: registration,
    latestVerificationRequest: request,
    policy: { listingRequiresLotEvidence: true, requiredLotEvidence: ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'], aiMayAssessButNotApprove: true },
    checkedAt: new Date().toISOString(),
    dataStatus: runtimeDataStatus,
  };
};

const createSimulationAccountSession = ({ businessRegistrationNumber, email, now = new Date().toISOString() }) => {
  const validation = validateKoreanBusinessRegistrationNumber(businessRegistrationNumber);
  if (!validation.valid) throw new TradeRuleError(validation.reason, 'BUSINESS_REGISTRATION_INVALID');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw new TradeRuleError('업무용 이메일 형식이 올바르지 않습니다.', 'BUSINESS_EMAIL_INVALID');
  const organizationId = `SIM-ORG-${createHash('sha256').update(validation.normalized).digest('hex').slice(0, 16)}`;
  const userId = `SIM-USER-${createHash('sha256').update(`${validation.normalized}:${normalizedEmail}`).digest('hex').slice(0, 16)}`;
  const key = `${validation.normalized}:${normalizedEmail}`;
  const existing = simulationBusinessAccounts.get(key);
  if (existing) return { account: existing, idempotent: true };
  const account = {
    userId,
    organizationId,
    businessRegistrationNumber: validation.normalized,
    formattedBusinessRegistrationNumber: validation.formatted,
    maskedBusinessRegistrationNumber: `${validation.normalized.slice(0, 3)}-${validation.normalized.slice(3, 5)}-****${validation.normalized.slice(-1)}`,
    email: normalizedEmail,
    status: 'REGISTERED',
    registrationMode: 'SIMULATION_CHECKSUM_ONLY',
    registeredAt: now,
  };
  simulationBusinessAccounts.set(key, account);
  return { account, idempotent: false };
};

const assertSimulationAccountSession = (principal) => {
  const account = [...simulationBusinessAccounts.values()].find((candidate) => candidate.userId === principal.userId && candidate.organizationId === principal.organizationId);
  if (!account) throw new TradeRuleError('공급자 작업을 시작하려면 사업자등록번호와 이메일로 먼저 계정을 등록해야 합니다.', 'ACCOUNT_SESSION_REQUIRED');
  return account;
};

const assertSimulationVerifiedSupplier = (principal) => {
  if (persistenceStore.mode === 'postgresql') return;
  if (!simulationSupplierEligibility(principal).eligibleToSubmitLot) throw new TradeRuleError('사업자·거래 자격이 확인된 공급자만 매물 등록과 주문 체결을 진행할 수 있습니다.', 'SUPPLIER_ORGANIZATION_NOT_VERIFIED');
};

const requestSimulationSupplierVerification = (principal, input) => {
  const businessRegistrationRef = String(input.businessRegistrationRef || '').trim();
  const evidenceRefs = input.evidenceRefs;
  if (!businessRegistrationRef || !evidenceRefs || typeof evidenceRefs !== 'object' || Array.isArray(evidenceRefs) || Object.keys(evidenceRefs).length === 0) throw new TradeRuleError('사업자·공급자 검증 증빙 참조가 필요합니다.', 'SUPPLIER_VERIFICATION_EVIDENCE_REQUIRED');
  const current = simulationSupplierVerificationRequests.get(principal.organizationId);
  if (principal.organizationId === SIMULATION_VERIFIED_SUPPLIER_ORG) return { request: null, approvalId: null, status: 'ALREADY_VERIFIED', idempotent: true, dataStatus: runtimeDataStatus };
  if (current) return { request: current, approvalId: current.approvalId, status: current.status, idempotent: true, dataStatus: runtimeDataStatus };
  const now = new Date().toISOString();
  const request = { requestId: `SIM-VERIFY-${principal.organizationId}-${Date.now()}`, approvalId: `SUPPLIER-VERIFY-${principal.organizationId}`, organizationId: principal.organizationId, requestedBy: principal.userId, businessRegistrationRef, evidenceRefs, status: 'REQUESTED', decisionNote: '', decidedBy: null, requestedAt: now, decidedAt: null };
  simulationSupplierVerificationRequests.set(principal.organizationId, request);
  return { request, approvalId: request.approvalId, status: request.status, idempotent: false, dataStatus: runtimeDataStatus };
};

const simulationSupplierApprovalItems = () => [...simulationSupplierVerificationRequests.values()].map((request) => ({ approvalId: request.approvalId, taskId: `SUPPLIER-VERIFICATION-${request.organizationId}`, sourceRunId: request.requestId, requiredPrincipal: 'H-01', objective: '공급자 검증 증빙의 운영 검토를 시작할지 결정한다.', risk: 'critical', reviewers: ['AI-09 콘트라', 'AI-11 실드'], status: request.approvalStatus || 'PENDING', decision: request.approvalDecision || null, decisionNote: request.approvalDecisionNote || '', decidedBy: request.approvalDecidedBy || null, createdAt: request.requestedAt, decidedAt: request.approvalDecidedAt || null }));
const simulationSupplierReviewItems = () => [...simulationSupplierVerificationRequests.values()].map((request) => ({ ...request, organizationName: null, approvalStatus: request.approvalStatus || 'PENDING' }));

const decideSimulationSupplierApproval = (request, { decision, note = '', decidedBy }) => {
  const statusByDecision = { approve: 'APPROVED', request_changes: 'CHANGES_REQUESTED', hold: 'HELD', reject: 'REJECTED' };
  const nextStatus = statusByDecision[String(decision || '').trim()];
  if (!nextStatus) throw new ApprovalStoreError('승인 결정은 approve·request_changes·hold·reject 중 하나여야 합니다.', 'APPROVAL_DECISION_INVALID');
  if (request.approvalStatus && request.approvalStatus !== 'PENDING') {
    if (request.approvalStatus === nextStatus && request.approvalDecidedBy === decidedBy) return { idempotent: true };
    throw new ApprovalStoreError('이미 결정된 공급자 검증 승인 대상은 다시 변경할 수 없습니다.', 'APPROVAL_ALREADY_DECIDED');
  }
  request.approvalStatus = nextStatus;
  request.approvalDecision = String(decision).trim();
  request.approvalDecisionNote = String(note || '').slice(0, 2000);
  request.approvalDecidedBy = decidedBy;
  request.approvalDecidedAt = new Date().toISOString();
  if (nextStatus === 'APPROVED') request.status = 'UNDER_REVIEW';
  if (nextStatus === 'REJECTED') request.status = 'REJECTED';
  return { idempotent: false };
};

const refreshEngineFromPersistence = async () => {
  if (persistenceStore.mode !== 'postgresql') return;
  const latest = await persistenceStore.load();
  if (latest) engine.restore(latest);
};

const readJson = async (request, { maxBytes = 64 * 1024 } = {}) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBytes) throw new TradeRuleError('요청 본문이 너무 큽니다.', 'PAYLOAD_TOO_LARGE');
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new TradeRuleError('JSON 요청 형식이 올바르지 않습니다.', 'INVALID_JSON'); }
};

const assertStoredSupplierPrecheckDocument = async (principal, input) => {
  const fileName = String(input.coaFileName || '').trim();
  const contentSha256 = String(input.coaFileSha256 || '').trim().toLowerCase();
  const storageRef = String(input.coaStorageRef || '').trim();
  if (!fileName || !/^[a-f0-9]{64}$/.test(contentSha256) || !storageRef) throw new TradeRuleError('COA 원문 저장 참조와 SHA-256 지문이 필요합니다.', 'COA_STORAGE_REFERENCE_REQUIRED');
  const storageKey = supplierPrecheckStorageKey({ organizationId: principal.organizationId, fileName, contentSha256 });
  const expectedRef = documentStorage.referenceForKey(storageKey);
  if (storageRef !== expectedRef) throw new TradeRuleError('COA 저장 참조가 공급자 조직·파일 지문과 일치하지 않습니다.', 'COA_STORAGE_REFERENCE_MISMATCH');
  let stored;
  try { stored = await documentStorage.getBinary(storageKey); } catch (error) { throw new TradeRuleError('COA 원문을 보관소에서 다시 확인할 수 없습니다.', error.code || 'COA_STORAGE_READ_FAILED'); }
  try { assertDocumentSignature({ fileName, contentBase64: stored.contentBase64 }); } catch (error) { throw new TradeRuleError(error.message, error.code || 'COA_STORAGE_SIGNATURE_INVALID'); }
  if (stored.contentSha256 !== contentSha256 || Number(stored.size) !== Number(input.coaFileSize)) throw new TradeRuleError('COA 원문 해시 또는 파일 크기가 사전검토 입력과 일치하지 않습니다.', 'COA_STORAGE_CONTENT_MISMATCH');
  return stored;
};

const persistAndPublishLedgerEvent = async () => {
  const snapshot = engine.snapshot();
  await persistenceStore.save(snapshot);
  const event = snapshot.events[0];
  eventBroker.publish('ledger', { dataStatus: runtimeDataStatus, event, snapshot }, event?.eventId || '');
};

const runLedgerMutation = async (mutation) => {
  if (persistenceStore.mode === 'postgresql') throw new TradeRuleError('PostgreSQL 상용 모드에서는 정규 도메인 API만 원장을 변경할 수 있습니다.', 'POSTGRES_DOMAIN_API_PATH_REQUIRED');
  if (typeof persistenceStore.runAtomic === 'function') {
    const outcome = await persistenceStore.runAtomic(engine, mutation);
    const event = outcome.snapshot.events[0];
    eventBroker.publish('ledger', { dataStatus: runtimeDataStatus, event, snapshot: outcome.snapshot }, event?.eventId || '');
    return outcome.result;
  }
  const before = engine.snapshot();
  try {
    const result = mutation();
    await persistAndPublishLedgerEvent();
    return result;
  } catch (error) {
    engine.restore(before);
    throw error;
  }
};

const refreshEvidenceFromPersistence = async () => {
  const latest = await persistenceStore.loadEvidence();
  if (latest) evidenceRegistry.restore(latest);
};

const runEvidenceMutation = async (mutation) => {
  const before = evidenceRegistry.snapshot();
  try {
    const result = mutation();
    await persistenceStore.saveEvidence(evidenceRegistry.snapshot());
    return result;
  } catch (error) {
    evidenceRegistry.restore(before);
    throw error;
  }
};

const publishDomainState = async ({ correlationId, eventType = 'DOMAIN_STATE_CHANGED', principal }) => {
  if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
  const snapshot = await domainAdapter.state();
  const event = snapshot.events.find((candidate) => candidate.correlationId === correlationId) || {
    eventId: correlationId,
    type: eventType,
    message: eventType,
    details: { correlationId },
    actorKind: 'SYSTEM',
    actorRef: 'DOMAIN-ADAPTER',
    correlationId,
    occurredAt: new Date().toISOString(),
  };
  eventBroker.publish('ledger', { dataStatus: runtimeDataStatus, event, snapshot }, event.eventId || correlationId || 'DOMAIN-STATE');
  return projectSnapshot(snapshot, principal);
};

const handleApi = async (request, response, url) => {
  try {
    if (request.method === 'POST' && url.pathname === '/api/test/shutdown' && environment === 'simulation' && process.env.ALLOW_TEST_SHUTDOWN === 'true') {
      sendJson(response, 200, { status: 'SHUTTING_DOWN' });
      setImmediate(() => { shutdown().finally(() => process.exit(0)); });
      return;
    }
    if (environment === 'production' && !(request.method === 'GET' && url.pathname === '/api/health')) {
      const principal = resolvePrincipal(request, { environment });
      if (!(await persistenceStore.isOrganizationMember(principal))) throw new AuthorizationError('인증된 사용자가 해당 조직의 활성 멤버가 아닙니다.', 'ORGANIZATION_MEMBERSHIP_REQUIRED');
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const principal = resolvePrincipal(request, { environment });
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new TradeRuleError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        return sendJson(response, 200, projectSnapshot(await domainAdapter.state(), principal));
      }
      await refreshEngineFromPersistence();
      return sendJson(response, 200, projectSnapshot(engine.snapshot(), principal));
    }
    if (request.method === 'GET' && url.pathname === '/api/market-board') {
      const principal = resolvePrincipal(request, { environment });
      authorize(principal, 'view_matched_offer', authorizationPolicy);
      const specId = String(url.searchParams.get('specId') || 'GABA-SPEC-001');
      let snapshot;
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new TradeRuleError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        snapshot = await domainAdapter.state();
      } else {
        await refreshEngineFromPersistence();
        snapshot = engine.snapshot();
      }
      return sendJson(response, 200, buildMarketBoard(snapshot, { specId, generatedAt: new Date().toISOString() }));
    }
    if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { service: 'raw-material-beta', dataStatus: runtimeDataStatus, persistence: { ...persistenceStatus(), runtimeMode: persistenceStore.mode }, eventStream: 'SSE' });
    if (request.method === 'POST' && url.pathname === '/api/goals/compile') {
      resolvePrincipal(request, { environment, fallbackRole: 'OPERATOR' });
      const input = await readJson(request);
      const result = await compileGoal(input);
      return sendJson(response, 200, { ...result, guardrail: '목표 컴파일은 계약·첫 읽기 작업·검증 계획을 준비할 뿐 외부 쓰기나 거래·계약·결제를 실행하지 않습니다.' });
    }
    if (request.method === 'GET' && url.pathname === '/api/ops/summary') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'OPERATOR' });
      authorize(principal, 'view_operational_audit', authorizationPolicy);
      const queue = await readOptionalJson(join(opsRoot, 'task-queue.json'), { tasks: [] });
      const approvalInbox = await readOptionalJson(join(opsRoot, 'approval-inbox.json'), { status: 'UNKNOWN', items: [], unresolvedEvidence: [] });
      const triggerInbox = await readOptionalJson(join(opsRoot, 'trigger-inbox.json'), { status: 'UNKNOWN', tasks: [], pending: 0 });
      const daemonStatus = await readOptionalJson(join(opsRoot, 'daemon-status.json'), { status: 'NOT_REPORTED', schemaVersion: 'OPS-DAEMON-STATUS-0.1' });
      const supervisorStatus = await readOptionalJson(join(opsRoot, 'company-supervisor-status.json'), { status: 'NOT_REPORTED', schemaVersion: 'COMPANY-SUPERVISOR-STATUS-0.1', pid: null, serverPid: null, daemonPid: null, serverRestarts: 0, daemonRestarts: 0, lastError: null });
      const projectedDaemonStatus = projectRuntimeLiveness(daemonStatus, { maxAgeMs: 20 * 60 * 1000 });
      const projectedSupervisorStatus = projectRuntimeLiveness(supervisorStatus, { maxAgeMs: 2 * 60 * 1000 });
      const notificationOutbox = await readOptionalJsonl(notificationOutboxPath);
      const currentNotificationRecords = latestOperationalNotifications(notificationOutbox.records);
      const latestRun = await readOptionalJson(join(opsRoot, 'latest-autopilot-run.json'), null);
      const latestCycle = await readOptionalJson(join(opsRoot, 'latest-ops-cycle.json'), null);
      const teamActivity = await readOptionalJson(join(opsRoot, 'latest-team-activity.json'), {
        schemaVersion: 'TEAM-ACTIVITY-0.1',
        generatedAt: null,
        cycleId: null,
        truthModel: 'RULE_DRIVEN_AUTOMATION_NOT_CONTINUOUS_LLM_BACKGROUND_THOUGHT',
        executionSummary: { automaticPreparation: false, pendingApprovalCount: 0 },
        counts: {},
        members: [],
      });
      const notificationDispatch = latestCycle?.automation?.notificationOutbox?.dispatch || {
        status: 'OUTBOX_ONLY', attemptedCount: 0, sentCount: 0, failedCount: 0, externalNotificationSent: false,
      };
      const taskTimelineAudit = latestCycle?.automation?.taskTimelineAudit || {
        status: 'NOT_REPORTED', activeViolationCount: 0, archiveViolationCount: 0, correctedCount: 0, remainingArchiveViolationCount: 0,
      };
      const taskAuditRemediation = latestCycle?.automation?.taskAuditRemediation || {
        status: 'NOT_REPORTED', planId: null, requiredApprovalId: null, actionCount: 0, eligibleActionCount: 0, appliedTaskIds: [], staleTaskIds: [],
      };
      const teamRoster = await readOptionalJson(resolve(root, '..', 'data', 'team-roster.json'), { schemaVersion: 'UNKNOWN', humanApprovalPrincipal: 'H-01', members: [], prohibitedAiDecisions: [] });
      const tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
      const terminalTaskStatuses = new Set(['done', 'approved', 'rejected', 'resolved']);
      const taskOwnershipErrors = validateTaskQueue({ roster: teamRoster, queue });
      const taskSla = evaluateTaskSla({ tasks });
      const supplierVerificationRequests = persistenceStore.mode === 'postgresql' && domainAdapter
        ? await domainAdapter.listSupplierVerificationRequests()
        : simulationSupplierReviewItems();
      const baseApprovalItems = persistenceStore.mode === 'postgresql' && domainAdapter
        ? await domainAdapter.listOperationalApprovals()
        : [...(Array.isArray(approvalInbox.items) ? approvalInbox.items : []), ...simulationSupplierApprovalItems()];
      const approvalItems = taskAuditRemediation.requiredApprovalId && !baseApprovalItems.some((item) => item.approvalId === taskAuditRemediation.requiredApprovalId)
        ? [...baseApprovalItems, {
          approvalId: taskAuditRemediation.requiredApprovalId,
          status: 'PENDING',
          requiredPrincipal: 'H-01',
          taskId: taskAuditRemediation.planId || 'TASK-AUDIT-REMEDIATION',
          objective: '업무 생명주기 감사 정정 계획의 적용 여부를 H-01이 결정한다.',
          risk: 'high',
          reviewers: ['AI-11 실드', 'AI-13 케어'],
          source: 'LATEST_OPS_CYCLE_REMEDIATION',
        }]
        : baseApprovalItems;
      const pendingApprovals = approvalItems.filter((item) => item.status === 'PENDING');
      const pendingNotifications = currentNotificationRecords.filter((item) => item.state === 'PENDING');
      return sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        service: 'raw-material-beta',
        dataStatus: runtimeDataStatus,
        teamRoster,
        taskOwnership: { status: taskOwnershipErrors.length ? 'INVALID' : 'VALID', total: tasks.length, valid: tasks.length - taskOwnershipErrors.length, errors: taskOwnershipErrors.slice(0, 10) },
        controlPlane: { queue: Array.isArray(queue.tasks) ? 'AVAILABLE' : 'INVALID', approvalInbox: approvalInbox.status || 'UNKNOWN', triggerInbox: triggerInbox.status || 'UNKNOWN', latestRun: latestRun ? 'AVAILABLE' : 'MISSING', daemon: projectedDaemonStatus.status || 'NOT_REPORTED', supervisor: projectedSupervisorStatus.status || 'NOT_REPORTED' },
        daemonStatus: projectedDaemonStatus,
        supervisorStatus: projectedSupervisorStatus,
        taskTimelineAudit,
        taskAuditRemediation,
        queue: {
          total: tasks.length,
          queued: tasks.filter((task) => task.status === 'queued').length,
          working: tasks.filter((task) => task.status === 'working').length,
          review: tasks.filter((task) => task.status === 'review').length,
           criticalOpen: tasks.filter((task) => task.risk === 'critical' && !terminalTaskStatuses.has(task.status)).length,
         },
         taskSla: {
           status: taskSla.status,
           activeCount: taskSla.activeCount,
           metadataCompleteCount: taskSla.metadataCompleteCount,
           staleCount: taskSla.staleCount,
           staleTasks: taskSla.items.filter((item) => item.stale),
         },
        approvalInbox: { status: pendingApprovals.length ? 'PENDING' : 'CLEAR', pending: pendingApprovals.length, unresolvedEvidence: Array.isArray(approvalInbox.unresolvedEvidence) ? approvalInbox.unresolvedEvidence.length : 0, items: approvalItems },
        approvalDecisionGuide: buildApprovalDecisionGuide(approvalItems),
        supplierVerification: { pendingRequests: supplierVerificationRequests.filter((item) => item.status === 'REQUESTED').length, awaitingFinalReview: supplierVerificationRequests.filter((item) => item.status === 'UNDER_REVIEW').length, items: supplierVerificationRequests },
        triggerInbox: { status: triggerInbox.status, pending: Number(triggerInbox.pending || 0), tasks: Array.isArray(triggerInbox.tasks) ? triggerInbox.tasks : [] },
        notificationOutbox: {
          status: notificationOutbox.parseError ? 'INVALID' : pendingNotifications.length ? 'PENDING' : 'CLEAR',
          total: currentNotificationRecords.length,
          pending: pendingNotifications.length,
          delivery: notificationDispatch.status,
          externalNotificationSent: notificationDispatch.externalNotificationSent === true,
          dispatch: notificationDispatch,
          parseError: notificationOutbox.parseError,
          items: currentNotificationRecords.slice(-20).reverse(),
        },
        readiness: await evaluateReleaseReadiness({ environment }),
        reconciliation: persistenceStore.mode === 'postgresql' && domainAdapter ? await domainAdapter.reconcileLatestBridge() : { status: 'SIMULATION_NOT_APPLICABLE', safe: true },
         latestRun: latestRun ? { runId: latestRun.runId, generatedAt: latestRun.generatedAt, decision: latestRun.decision, selectedTask: latestRun.selectedTask?.id || null, selectedOwner: latestRun.workPacket?.ownerAi || latestRun.selectedTask?.ownerAi || null, workPacketId: latestRun.workPacket?.packetId || null, workPacketStatus: latestRun.workPacket?.status || null, patentPacketId: latestRun.patentPacket?.packetId || null, patentPacketStatus: latestRun.patentPacket?.legalStatus || null, failedEvidence: (latestRun.evidence || []).filter((item) => !item.passed).map((item) => item.name), skippedEvidence: (latestRun.evidence || []).filter((item) => item.skipped).map((item) => item.name) } : null,
         teamActivity,
         guardrails: { tradeApprovalByAi: false, paymentReleaseByAi: false, disputeClosureByAi: false, productionRelease: 'READINESS_GO_REQUIRED' },
      });
    }
    const notificationAckMatch = url.pathname.match(/^\/api\/ops\/notifications\/([^/]+)\/ack$/);
    if (request.method === 'POST' && notificationAckMatch) {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'OPERATOR' });
      authorize(principal, 'acknowledge_operational_alert', authorizationPolicy);
      if (principal.role === 'AI') throw new AuthorizationError('AI는 운영 알림을 확인 처리할 수 없습니다.', 'HUMAN_ACKNOWLEDGER_REQUIRED');
      const input = await readJson(request);
      const notificationId = decodeURIComponent(notificationAckMatch[1]);
      const result = await acknowledgeOperationalNotification(notificationOutboxPath, notificationId, { acknowledgedBy: principal.userId, note: input.note });
      return sendJson(response, 200, { notification: result.record, idempotent: result.idempotent, guardrail: '알림 확인은 수신·조치 검토 사실만 기록하며, 거래·계약·결제·상용 전환을 승인하지 않습니다.' });
    }
    const approvalMatch = url.pathname.match(/^\/api\/ops\/approvals\/([^/]+)$/);
    if (request.method === 'POST' && approvalMatch) {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'OWNER' });
      authorize(principal, 'decide_operational_approval', authorizationPolicy);
      if (environment === 'simulation' && principal.userId !== 'H-01') throw new AuthorizationError('시뮬레이션 승인자는 H-01이어야 합니다.', 'HUMAN_APPROVER_REQUIRED');
      const input = await readJson(request);
      const approvalId = decodeURIComponent(approvalMatch[1]);
      const simulationRequest = [...simulationSupplierVerificationRequests.values()].find((requestItem) => requestItem.approvalId === approvalId);
      if (environment !== 'production' && persistenceStore.mode !== 'postgresql' && simulationRequest) {
        const decisionResult = decideSimulationSupplierApproval(simulationRequest, { ...input, decidedBy: principal.userId });
        const approval = simulationSupplierApprovalItems().find((item) => item.approvalId === approvalId);
        return sendJson(response, 200, { approval, idempotent: decisionResult.idempotent, guardrail: '공급자 검증 승인도 검토 진행 허가일 뿐이며, 최종 자격은 별도 인간 증빙 검토 후 확정됩니다.' });
      }
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 승인 어댑터가 연결되지 않았습니다.', 'POSTGRES_APPROVAL_ADAPTER_REQUIRED');
        const domainResult = await domainAdapter.decideOperationalApproval({ ...input, approvalId, decidedBy: principal.userId, actorKind: 'HUMAN', correlationId: String(input.idempotencyKey || `APPROVAL-${approvalId}-${Date.now()}`) });
        return sendJson(response, 200, { approval: domainResult.item, idempotent: domainResult.idempotent, guardrail: '승인은 운영 업무의 다음 단계 결정이며 실제 거래·계약·결제의 자동 실행을 의미하지 않습니다.' });
      }
      const result = await decideApproval(join(opsRoot, 'approval-inbox.json'), approvalLogPath, decodeURIComponent(approvalMatch[1]), { ...input, decidedBy: principal.userId });
      let taskSync = { status: 'NOT_APPLICABLE', taskId: result.item?.taskId || null, idempotent: true };
      if (result.item?.taskId) {
        try {
          taskSync = await syncTaskApproval({
            queuePath: join(opsRoot, 'task-queue.json'),
            auditPath: join(opsRoot, 'task-approval-sync.jsonl'),
            approvalId,
            taskId: result.item.taskId,
            decision: result.item.decision,
            decidedBy: result.item.decidedBy,
            decidedAt: result.item.decidedAt,
            note: result.item.decisionNote,
          });
        } catch (error) {
          if (!(error instanceof TaskApprovalSyncError) || !['TASK_QUEUE_NOT_FOUND', 'TASK_QUEUE_INVALID'].includes(error.code)) throw error;
          taskSync = { status: 'NOT_APPLICABLE', taskId: result.item.taskId, idempotent: true, reason: error.code, guardrail: '승인은 기록되었지만 작업 큐가 연결되지 않은 격리 환경이므로 큐 동기화는 적용하지 않았습니다.' };
        }
      }
      return sendJson(response, 200, { approval: result.item, taskSync, idempotent: result.idempotent, guardrail: '승인은 운영 업무의 다음 단계 결정이며 실제 거래·계약·결제의 자동 실행을 의미하지 않습니다.' });
    }
    if (request.method === 'GET' && url.pathname === '/api/readiness') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'OPERATOR' });
      authorize(principal, 'view_release_readiness', authorizationPolicy);
      return sendJson(response, 200, await evaluateReleaseReadiness({ environment }));
    }
    if (request.method === 'GET' && url.pathname === '/api/events') {
      resolvePrincipal(request, { environment });
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const principal = resolvePrincipal(request, { environment });
      const transform = (payload) => payload.snapshot ? ({ ...payload, snapshot: projectSnapshot(payload.snapshot, principal) }) : payload;
      const remove = eventBroker.add(response, transform);
      const snapshot = persistenceStore.mode === 'postgresql'
        ? await domainAdapter.state()
        : (await refreshEngineFromPersistence(), engine.snapshot());
      eventBroker.send(response, 'snapshot', transform({ dataStatus: runtimeDataStatus, event: snapshot.events[0], snapshot }), snapshot.events[0]?.eventId || '');
      request.on('close', remove);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/materials') {
      resolvePrincipal(request, { environment });
      return sendJson(response, 200, materialMasterSnapshot());
    }
    if (request.method === 'GET' && url.pathname === '/api/materials/resolve') {
      resolvePrincipal(request, { environment });
      return sendJson(response, 200, { query: url.searchParams.get('q') || '', match: resolveMaterial(url.searchParams.get('q')) });
    }
    if (request.method === 'GET' && url.pathname === '/api/materials/search') {
      resolvePrincipal(request, { environment });
      const query = url.searchParams.get('q') || '';
      return sendJson(response, 200, { query, matches: searchMaterials(query, { limit: url.searchParams.get('limit') }) });
    }
    if (request.method === 'POST' && url.pathname === '/api/spec-compile') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'BUYER' });
      authorize(principal, 'view_matched_offer', authorizationPolicy);
      return sendJson(response, 200, compileSpecDraft(await readJson(request)));
    }
    if (request.method === 'GET' && url.pathname === '/api/price-index') {
      resolvePrincipal(request, { environment });
      return sendJson(response, 200, priceFeed.calculate(url.searchParams.get('specId') || 'GABA-SPEC-001'));
    }
    if (request.method === 'GET' && url.pathname === '/api/price-feed/status') {
      resolvePrincipal(request, { environment });
      return sendJson(response, 200, priceFeed.status());
    }
    if (request.method === 'GET' && url.pathname === '/api/supplier/eligibility') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'create_lot', authorizationPolicy);
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        return sendJson(response, 200, { ...await domainAdapter.supplierEligibility(principal.organizationId), dataStatus: runtimeDataStatus });
      }
      return sendJson(response, 200, simulationSupplierEligibility(principal));
    }
    if (request.method === 'POST' && url.pathname === '/api/account/session') {
      const input = await readJson(request);
      if (persistenceStore.mode === 'postgresql' || environment !== 'simulation') {
        throw new TradeRuleError('상용 로그인·사업자 확인은 공식 인증 서비스와 영속 계정 원장 연동 후에만 사용할 수 있습니다.', 'ACCOUNT_PROVIDER_REQUIRED');
      }
      const result = createSimulationAccountSession({ businessRegistrationNumber: input.businessRegistrationNumber || input.businessNumber, email: input.email });
      return sendJson(response, result.idempotent ? 200 : 201, {
        account: result.account,
        status: 'ACCOUNT_REGISTERED',
        idempotent: result.idempotent,
        dataStatus: runtimeDataStatus,
        guardrail: '베타 시뮬레이션 계정입니다. 사업자번호 형식·체크섬 확인은 공식 기관 조회를 대체하지 않으며, 실거래·결제는 비활성화되어 있습니다.',
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/supplier/registration') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'request_supplier_verification', authorizationPolicy);
      const input = await readJson(request);
      if (persistenceStore.mode === 'postgresql' || environment !== 'simulation') {
        throw new TradeRuleError('상용 공급자 등록은 국세청 등 공식 사업자 확인 서비스 연동 후에만 사용할 수 있습니다.', 'BUSINESS_REGISTRATION_PROVIDER_REQUIRED');
      }
      const account = assertSimulationAccountSession(principal);
      const validation = validateKoreanBusinessRegistrationNumber(input.businessRegistrationNumber || input.businessNumber);
      if (!validation.valid) throw new TradeRuleError(validation.reason, 'BUSINESS_REGISTRATION_INVALID');
      const registrationEmail = String(input.email || '').trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(registrationEmail)) throw new TradeRuleError('공급자 등록에는 유효한 업무용 이메일이 필요합니다.', 'BUSINESS_EMAIL_INVALID');
      if (account.businessRegistrationNumber !== validation.normalized || account.email !== registrationEmail) throw new TradeRuleError('공급자 등록 정보는 로그인한 사업자 계정과 일치해야 합니다.', 'ACCOUNT_SESSION_MISMATCH');
      const existing = simulationSupplierRegistrations.get(principal.organizationId) || null;
      if (existing) {
        if (existing.businessRegistrationNumber !== validation.normalized) throw new TradeRuleError('이 공급자 조직에는 이미 다른 사업자등록번호가 등록되어 있습니다.', 'BUSINESS_REGISTRATION_ALREADY_REGISTERED');
        return sendJson(response, 200, {
          registration: existing,
          status: 'AUTO_REGISTERED',
          idempotent: true,
          dataStatus: runtimeDataStatus,
          guardrail: '공급자 계정만 자동 등록되었습니다. COA·SDS·TDS·로트추적·재고 증빙 검증 전에는 매물·체결 권한을 열지 않습니다.',
        });
      }
      const owner = simulationSupplierRegistrationOwners.get(validation.normalized);
      if (owner && owner !== principal.organizationId) throw new TradeRuleError('이미 다른 공급자 조직에 등록된 사업자등록번호입니다.', 'BUSINESS_REGISTRATION_ALREADY_USED');
      const registration = createSimulationSupplierRegistration({
        organizationId: principal.organizationId,
        userId: principal.userId,
        businessRegistrationNumber: validation.normalized,
        email: registrationEmail,
        legalName: input.legalName,
      });
      simulationSupplierRegistrations.set(principal.organizationId, registration);
      simulationSupplierRegistrationOwners.set(validation.normalized, principal.organizationId);
      return sendJson(response, 201, {
        registration,
        status: 'AUTO_REGISTERED',
        idempotent: false,
        dataStatus: runtimeDataStatus,
        guardrail: '공급자 계정만 자동 등록되었습니다. COA·SDS·TDS·로트추적·재고 증빙 검증 전에는 매물·체결 권한을 열지 않습니다.',
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/supplier/precheck') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'upload_evidence', authorizationPolicy);
      if (environment === 'simulation' && persistenceStore.mode !== 'postgresql') assertSimulationAccountSession(principal);
      const input = await readJson(request);
      await assertStoredSupplierPrecheckDocument(principal, input);
      const review = evaluateSupplierAiPrecheck({ ...input, coaFileSignatureVerified: true });
      const idempotencyKey = String(input.idempotencyKey || `${input.coaFileName || 'coa'}-${input.coaFileSize || 0}-${input.inventoryQuantity || 0}-${input.unit || ''}`).slice(0, 160);
      const key = `${principal.organizationId}:${idempotencyKey}`;
      const inputFingerprint = supplierPrecheckFingerprint(input);
      const existing = simulationSupplierPrechecks.get(key);
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter || typeof domainAdapter.supplierPrecheck !== 'function') throw new PostgresDomainAdapterError('정규 PostgreSQL 공급자 사전검토 어댑터가 연결되지 않았습니다.', 'POSTGRES_SUPPLIER_PRECHECK_ADAPTER_REQUIRED');
        const result = await domainAdapter.supplierPrecheck({
          ...normalizeSupplierPrecheckInput(input),
          supplierOrganizationId: principal.organizationId,
          supplierUserId: principal.userId,
          idempotencyKey,
          inputFingerprint,
          review,
          actorKind: 'SYSTEM',
          actorRef: 'AI-SUPPLIER-PRECHECK',
          correlationId: `SUPPLIER-PRECHECK-${idempotencyKey}`,
        });
        return sendJson(response, result.idempotent ? 200 : 201, { ...result, dataStatus: runtimeDataStatus, guardrail: '상용 AI 사전검토는 PostgreSQL 원장에 멱등 저장되며, 공급자 승인·매물 공개·거래 체결을 수행하지 않습니다.' });
      }
      if (existing) {
        const existingFingerprint = existing.inputFingerprint || supplierPrecheckFingerprint(existing);
        if (existingFingerprint !== inputFingerprint) throw new TradeRuleError('같은 멱등키로 다른 공급 조건을 재사용할 수 없습니다.', 'IDEMPOTENCY_KEY_REUSE_MISMATCH');
        return sendJson(response, 200, { precheck: existing, review: existing.review, status: 'PRECHECK_REVIEWED', idempotent: true, dataStatus: runtimeDataStatus });
      }
      const normalizedInput = normalizeSupplierPrecheckInput(input);
      const precheck = { precheckId: `SIM-SUPPLIER-PRECHECK-${Date.now()}`, organizationId: principal.organizationId, reviewedBy: 'AI-SUPPLIER-PRECHECK', ...normalizedInput, inputFingerprint, review };
      simulationSupplierPrechecks.set(key, precheck);
      return sendJson(response, 201, { precheck, review, status: 'PRECHECK_REVIEWED', idempotent: false, dataStatus: runtimeDataStatus });
    }
    if (request.method === 'POST' && url.pathname === '/api/supplier/precheck-document') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'upload_evidence', authorizationPolicy);
      if (environment === 'simulation' && persistenceStore.mode !== 'postgresql') assertSimulationAccountSession(principal);
      const input = await readJson(request, { maxBytes: 15 * 1024 * 1024 });
      const fileName = String(input.fileName || '').trim();
      const contentBase64 = String(input.contentBase64 || '').trim();
      const contentSha256 = String(input.contentSha256 || '').trim().toLowerCase();
      if (!fileName || !contentBase64 || !/^[a-f0-9]{64}$/.test(contentSha256)) throw new TradeRuleError('COA 파일명·원문·SHA-256 지문이 필요합니다.', 'COA_UPLOAD_INPUT_REQUIRED');
      try { assertDocumentSignature({ fileName, contentBase64 }); } catch (error) { throw new TradeRuleError(error.message, error.code || 'COA_FILE_SIGNATURE_INVALID'); }
      const storageKey = supplierPrecheckStorageKey({ organizationId: principal.organizationId, fileName, contentSha256 });
      if (typeof documentStorage.putBinary !== 'function') throw new TradeRuleError('바이너리 Object Storage 어댑터가 연결되지 않았습니다.', 'DOCUMENT_BINARY_STORAGE_REQUIRED');
      const stored = await documentStorage.putBinary({ key: storageKey, contentBase64, contentSha256, contentType: String(input.contentType || 'application/octet-stream') });
      return sendJson(response, 201, { document: { ...stored, storageKey, fileName, contentSha256 }, status: 'DOCUMENT_STORED', dataStatus: runtimeDataStatus, guardrail: '원문은 저장 어댑터에 보관하고, 이후 사전검토·증빙 원장에는 저장 참조와 해시만 결속합니다.' });
    }
    if (request.method === 'POST' && url.pathname === '/api/supplier/verification-request') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'request_supplier_verification', authorizationPolicy);
      if (environment === 'simulation' && persistenceStore.mode !== 'postgresql') assertSimulationAccountSession(principal);
      const input = await readJson(request);
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        const result = await domainAdapter.requestSupplierVerification({
          ...input,
          supplierOrganizationId: principal.organizationId,
          supplierUserId: principal.userId,
          actorKind: 'HUMAN',
          actorRef: principal.userId,
          correlationId: String(input.idempotencyKey || `SUPPLIER-VERIFY-${principal.organizationId}-${Date.now()}`),
        });
        return sendJson(response, result.idempotent ? 200 : 201, { ...result, dataStatus: runtimeDataStatus, guardrail: '공급자 검증 요청은 접수만 하며, H-01 또는 지정 운영자의 승인 전에는 매물·체결 권한을 열지 않습니다.' });
      }
      return sendJson(response, 200, { ...requestSimulationSupplierVerification(principal, input), guardrail: '시뮬레이션에서 접수된 요청도 H-01 승인 대기 상태이며, 승인 전에는 매물·체결 권한을 열지 않습니다.' });
    }
    const supplierVerificationReviewMatch = url.pathname.match(/^\/api\/supplier\/verification-requests\/([^/]+)\/review$/);
    if (request.method === 'POST' && supplierVerificationReviewMatch) {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'OWNER' });
      authorize(principal, 'approve_supplier', authorizationPolicy);
      if (environment === 'simulation' && principal.userId !== 'H-01') throw new AuthorizationError('시뮬레이션 공급자 검토자는 H-01이어야 합니다.', 'HUMAN_APPROVER_REQUIRED');
      const input = await readJson(request);
      if (persistenceStore.mode !== 'postgresql' || !domainAdapter) throw new PostgresDomainAdapterError('공급자 검토는 정규 PostgreSQL 원장에서만 확정할 수 있습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
      const result = await domainAdapter.reviewSupplierVerification({
        ...input,
        requestId: decodeURIComponent(supplierVerificationReviewMatch[1]),
        reviewerOrganizationId: principal.organizationId,
        reviewerUserId: principal.userId,
        actorKind: 'HUMAN',
        actorRef: principal.userId,
        correlationId: String(input.idempotencyKey || `SUPPLIER-VERIFY-REVIEW-${Date.now()}`),
      });
      return sendJson(response, result.idempotent ? 200 : 201, { ...result, dataStatus: runtimeDataStatus, guardrail: '최종 공급자 자격은 권한 있는 인간 검토자가 증빙을 확인한 경우에만 조직 원장에 기록됩니다.' });
    }
    if (request.method === 'GET' && url.pathname === '/api/evidence-policy') {
      resolvePrincipal(request, { environment });
      return sendJson(response, 200, loadEvidencePolicy());
    }
    if (request.method === 'GET' && url.pathname === '/api/evidence') {
      const principal = resolvePrincipal(request, { environment });
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        return sendJson(response, 200, projectEvidence(await domainAdapter.listEvidence(url.searchParams.get('lotId') || ''), principal));
      }
      await refreshEvidenceFromPersistence();
      return sendJson(response, 200, projectEvidence(evidenceRegistry.list(url.searchParams.get('lotId')), principal));
    }
    if (request.method === 'GET' && url.pathname === '/api/evidence/eligibility') {
      resolvePrincipal(request, { environment });
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        return sendJson(response, 200, await domainAdapter.evidenceEligibility(url.searchParams.get('lotId') || ''));
      }
      await refreshEvidenceFromPersistence();
      return sendJson(response, 200, evidenceRegistry.eligibility(url.searchParams.get('lotId')));
    }
    if (request.method === 'POST' && url.pathname === '/api/evidence') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'upload_evidence', authorizationPolicy);
      const input = await readJson(request);
      const stored = await documentStorage.put({
        key: `${input.lotId || ''}/${input.evidenceType || ''}/${input.documentVersion || ''}`,
        content: input.content,
        contentSha256: input.contentSha256,
      });
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        const domainResult = await domainAdapter.submitEvidence({ ...input, storageRef: stored.storageRef, contentSha256: stored.contentSha256, supplierUserId: principal.userId, supplierOrganizationId: principal.organizationId, actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `EVIDENCE-${Date.now()}`) });
        return sendJson(response, 201, { ...domainResult, snapshot: await publishDomainState({ correlationId: domainResult.correlationId, eventType: 'EVIDENCE_SUBMITTED', principal }) });
      }
      const result = await runEvidenceMutation(() => evidenceRegistry.submit({ ...input, storageRef: stored.storageRef, contentSha256: stored.contentSha256, submittedBy: principal.userId, organizationId: principal.organizationId }));
      return sendJson(response, 201, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/lots') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'create_lot', authorizationPolicy);
      const input = await readJson(request);
      assertSimulationVerifiedSupplier(principal);
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        const domainResult = await domainAdapter.registerLotDraft({ ...input, supplierUserId: principal.userId, supplierOrganizationId: principal.organizationId, actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `LOT-${input.lotId || Date.now()}`) });
        return sendJson(response, 201, { lot: domainResult.lot, offer: domainResult.offer, evidence: domainResult.evidence, snapshot: await publishDomainState({ correlationId: domainResult.correlationId, eventType: 'LOT_VERIFIED', principal }) });
      }
      await refreshEvidenceFromPersistence();
      const eligibility = evidenceRegistry.eligibility(input.lotId);
      if (!eligibility.preTradeEligible) throw new TradeRuleError('COA·SDS·TDS·로트추적·재고증빙이 모두 유효해야 매물을 등록할 수 있습니다.', 'PRETRADE_EVIDENCE_REQUIRED');
      const records = evidenceRegistry.list(input.lotId);
      if (records.some((record) => record.organizationId && record.organizationId !== principal.organizationId)) throw new TradeRuleError('다른 조직의 증빙으로 매물을 등록할 수 없습니다.', 'EVIDENCE_ORGANIZATION_MISMATCH');
      const result = await runLedgerMutation(() => engine.registerVerifiedLot({ ...input, supplierId: principal.userId, supplierOrganizationId: principal.organizationId, evidence: records }));
      return sendJson(response, 201, result);
    }
    const evidenceReviewMatch = url.pathname.match(/^\/api\/evidence\/([^/]+)\/review$/);
    if (request.method === 'POST' && evidenceReviewMatch) {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'OPERATOR' });
      authorize(principal, 'verify_document', authorizationPolicy);
      const input = await readJson(request);
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        const domainResult = await domainAdapter.reviewEvidence({ ...input, evidenceId: decodeURIComponent(evidenceReviewMatch[1]), operatorUserId: principal.userId, operatorOrganizationId: principal.organizationId, actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `EVIDENCE-REVIEW-${Date.now()}`) });
        return sendJson(response, 200, { ...domainResult, snapshot: await publishDomainState({ correlationId: domainResult.correlationId, eventType: 'EVIDENCE_REVIEWED', principal }) });
      }
      await refreshEvidenceFromPersistence();
      const result = await runEvidenceMutation(() => evidenceRegistry.review(decodeURIComponent(evidenceReviewMatch[1]), { ...input, reviewerRole: principal.role, reviewerId: principal.userId }));
      return sendJson(response, 200, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/orders') {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'BUYER' });
      authorize(principal, 'create_order', authorizationPolicy);
      const input = { ...(await readJson(request)), buyerId: principal.userId, buyerOrganizationId: principal.organizationId };
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new TradeRuleError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        if (!String(input.idempotencyKey || '').trim()) throw new TradeRuleError('상용 주문에는 idempotencyKey가 필요합니다.', 'IDEMPOTENCY_KEY_REQUIRED');
        const domainResult = await domainAdapter.submitOrder({ ...input, userId: principal.userId, bidPrice: input.price, requestedQuantity: input.quantity, deliveryDeadline: input.deliveryDate || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `ORDER-${Date.now()}`) });
        return sendJson(response, domainResult.idempotent ? 200 : 201, { order: mapOrder(domainResult.order), idempotent: domainResult.idempotent, snapshot: await publishDomainState({ correlationId: domainResult.correlationId, eventType: 'ORDER_SUBMITTED', principal }) });
      }
      const result = await runLedgerMutation(() => engine.submitOrder(input));
      return sendJson(response, 201, result);
    }
    const acceptMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/accept$/);
    if (request.method === 'POST' && acceptMatch) {
      const principal = resolvePrincipal(request, { environment, fallbackRole: 'SUPPLIER' });
      authorize(principal, 'accept_order', authorizationPolicy);
      assertSimulationVerifiedSupplier(principal);
      const orderId = decodeURIComponent(acceptMatch[1]);
      const input = { ...(await readJson(request)), supplierId: principal.userId, supplierOrganizationId: principal.organizationId };
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        const domainResult = await domainAdapter.acceptOrder({ ...input, orderId, supplierUserId: principal.userId, actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `ACCEPT-${orderId}-${Date.now()}`) });
        return sendJson(response, 200, { order: mapOrder(domainResult.order), trade: mapTrade(domainResult.trade), snapshot: await publishDomainState({ correlationId: domainResult.correlationId, eventType: 'TRADE_CONFIRMED', principal }) });
      }
      const result = await runLedgerMutation(() => engine.acceptOrder(orderId, input));
      return sendJson(response, 200, result);
    }
    const actionMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/(counter|reject|expire)$/);
    if (request.method === 'POST' && actionMatch) {
      const orderId = decodeURIComponent(actionMatch[1]);
      const action = actionMatch[2];
      const principal = resolvePrincipal(request, { environment, fallbackRole: action === 'expire' ? 'OPERATOR' : 'SUPPLIER' });
      const permission = action === 'counter' ? 'counter_order' : action === 'reject' ? 'reject_order' : 'expire_order';
      authorize(principal, permission, authorizationPolicy);
      if (action === 'counter') assertSimulationVerifiedSupplier(principal);
      const input = { ...(await readJson(request)), supplierId: principal.userId, supplierOrganizationId: principal.organizationId };
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        const domainInput = { ...input, orderId, supplierUserId: principal.userId, actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `${action.toUpperCase()}-${orderId}-${Date.now()}`) };
        const domainResult = action === 'counter' ? await domainAdapter.counterOrder({ ...domainInput, price: input.price, quantity: input.quantity, deliveryDays: input.deliveryDays, lotId: input.lotId }) : action === 'reject' ? await domainAdapter.rejectOrder(domainInput) : await domainAdapter.expireOrder({ orderId, actorKind: 'SYSTEM', actorRef: principal.userId, correlationId: domainInput.correlationId });
        const eventType = { counter: 'ORDER_COUNTERED', reject: 'ORDER_REJECTED', expire: 'ORDER_EXPIRED' }[action];
        return sendJson(response, 200, { order: mapOrder(domainResult.order), snapshot: await publishDomainState({ correlationId: domainResult.correlationId, eventType, principal }) });
      }
      const result = await runLedgerMutation(() => action === 'counter' ? engine.counterOrder(orderId, input) : action === 'reject' ? engine.rejectOrder(orderId, input) : engine.expireOrder(orderId));
      return sendJson(response, 200, result);
    }
    const tradeLifecycleMatch = url.pathname.match(/^\/api\/trades\/([^/]+)\/(deliver|inspect)$/);
    if (request.method === 'POST' && tradeLifecycleMatch) {
      const tradeId = decodeURIComponent(tradeLifecycleMatch[1]);
      const action = tradeLifecycleMatch[2];
      const principal = resolvePrincipal(request, { environment, fallbackRole: action === 'deliver' ? 'SUPPLIER' : 'OPERATOR' });
      const permission = action === 'deliver' ? 'mark_delivery' : 'inspect_trade';
      authorize(principal, permission, authorizationPolicy);
      const input = await readJson(request);
      if (persistenceStore.mode === 'postgresql') {
        if (!domainAdapter) throw new PostgresDomainAdapterError('정규 PostgreSQL 도메인 어댑터가 연결되지 않았습니다.', 'POSTGRES_DOMAIN_ADAPTER_REQUIRED');
        const domainResult = action === 'deliver'
          ? await domainAdapter.markDelivered({ tradeId, supplierOrganizationId: principal.organizationId, supplierUserId: principal.userId, actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `DELIVER-${tradeId}-${Date.now()}`) })
          : await domainAdapter.inspectTradeAndRecordPrice({ ...input, tradeId, operatorOrganizationId: principal.organizationId, operatorUserId: principal.userId, actorKind: 'HUMAN', actorRef: principal.userId, correlationId: String(input.idempotencyKey || `INSPECT-${tradeId}-${Date.now()}`) });
        let result = { trade: mapTrade(domainResult.trade), inspection: domainResult.inspection || null };
        if (action === 'inspect' && domainResult.observation) result = { ...result, observation: domainResult.observation, priceObservationIdempotent: domainResult.priceObservationIdempotent };
        return sendJson(response, 200, { ...result, snapshot: await publishDomainState({ correlationId: action === 'inspect' && domainResult.trade.state === 'COMPLETED' ? `${domainResult.correlationId}:PRICE` : domainResult.correlationId, eventType: action === 'deliver' ? 'TRADE_DELIVERED' : 'TRADE_INSPECTED', principal }) });
      }
      const result = await runLedgerMutation(() => action === 'deliver' ? engine.markDelivered(tradeId) : engine.inspectTrade(tradeId, input));
      if (action === 'inspect' && result.trade.status === 'FULFILLED') {
        const priceIngest = priceFeed.ingest({ sourceType: 'COMPLETED_PHYSICAL_TRADE', observations: [{ tradeId: result.trade.tradeId, specId: result.trade.specId, supplierId: result.trade.supplierId, price: result.trade.price, quantity: result.trade.quantity, quantityUnit: 'KG', priceUnit: 'KRW_PER_KG', currency: 'KRW', fulfilledAt: result.trade.fulfilledAt, status: 'FULFILLED', evidenceStatus: 'VALID' }] });
        await persistenceStore.savePriceObservations(priceIngest.acceptedObservations);
      }
      return sendJson(response, 200, result);
    }
    return sendJson(response, 404, { error: 'API 경로를 찾을 수 없습니다.', code: 'API_NOT_FOUND' });
  } catch (error) {
    const status = error instanceof AuthorizationError ? (error.code === 'AUTHENTICATION_REQUIRED' ? 401 : 403) : error instanceof TradeRuleError || error instanceof EvidenceRegistryError || error instanceof SpecCompilerError || error instanceof ApprovalStoreError || error instanceof NotificationOutboxError || error instanceof PostgresDomainAdapterError ? 422 : 500;
    return sendJson(response, status, { error: error.message || '서버 처리에 실패했습니다.', code: error.code || 'INTERNAL_ERROR' });
  }
};

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
  const requestPath = decodeURIComponent(url.pathname);
  const candidate = normalize(join(root, requestPath === '/' ? 'index.html' : requestPath.slice(1)));
  if (!candidate.startsWith(root)) return response.writeHead(403, securityHeaders).end('Forbidden');
  try {
    const body = await readFile(candidate);
    response.writeHead(200, { ...securityHeaders, 'Content-Type': types[extname(candidate)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404, securityHeaders).end('Not Found');
  }
});

const heartbeatTimer = setInterval(() => eventBroker.heartbeat(), Number(process.env.HEARTBEAT_INTERVAL_MS || 15000));
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  httpServer.closeAllConnections?.();
  await new Promise((resolve) => httpServer.close(() => resolve()));
  await persistenceStore.close();
};
process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });

httpServer.listen(port, host, () => console.log(`Beta server listening on http://${host}:${port}/`));

