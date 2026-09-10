import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

// Autopilot and CI may run this integration test at the same time. Derive a
// per-process default port so one test worker cannot make another worker
// appear to hang on the shared fixed port.
const port = Number(process.env.API_AUTH_TEST_PORT || (4177 + (process.pid % 1000)));
const productionStartupTimeoutMs = Number(process.env.API_AUTH_PRODUCTION_STARTUP_TIMEOUT_MS || 10000);
const cwd = fileURLToPath(new URL('.', import.meta.url));
const child = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, PORT: String(port), APP_ENV: 'production', PERSISTENCE_MODE: 'memory' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const waitForExit = new Promise((resolve) => child.once('exit', resolve));
const opsRoot = await mkdtemp(join(tmpdir(), 'raw-material-api-ops-'));
await writeFile(join(opsRoot, 'approval-inbox.json'), `${JSON.stringify({ schemaVersion: 'APPROVAL-INBOX-0.1', status: 'PENDING', items: [{ approvalId: 'APPROVAL-API-001', status: 'PENDING', taskId: 'TASK-API-001', sourceRunId: 'RUN-API-001' }] })}\n`);
await writeFile(join(opsRoot, 'notification-outbox.jsonl'), `${JSON.stringify({ schemaVersion: 'OPS-NOTIFICATION-0.1', notificationId: 'NOTIFY-API-001', notificationType: 'RELEASE_NO_GO', fingerprint: 'readiness:api-test', severity: 'CRITICAL', title: 'API 테스트 운영 알림', message: '테스트용 확인 대상', requiredPrincipal: 'H-01', action: 'HOLD_REAL_OPERATIONS', state: 'PENDING', delivery: 'OUTBOX_ONLY' })}\n`);
try {
  const exitCode = await Promise.race([waitForExit, new Promise((resolve) => setTimeout(() => resolve('timeout'), productionStartupTimeoutMs))]);
  assert.notEqual(exitCode, 'timeout', 'production server must fail closed before listening');
  assert.notEqual(exitCode, 0);

  const simulationChild = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', OPS_ROOT: opsRoot }, stdio: 'ignore' });
  try {
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { response = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ specId: 'GABA-SPEC-001', specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 20, deliveryDays: 14 }) }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.equal(response?.status, 201);
    const order = await response.json();
    const specDraft = await fetch(`${base}/api/spec-compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '가바', answers: {} }) });
    assert.equal(specDraft.status, 200);
    assert.equal((await specDraft.json()).nextQuestion.field, 'intendedUse');
    const materialSearch = await fetch(`${base}/api/materials/search?q=가바&limit=5`);
    assert.equal(materialSearch.status, 200);
    const materialSearchBody = await materialSearch.json();
    assert.equal(materialSearchBody.matches[0].materialId, 'GABA');
    assert.equal(materialSearchBody.matches[0].matchType, 'EXACT');
    const unknownMaterialSearch = await fetch(`${base}/api/materials/search?q=미등록원료&limit=5`);
    assert.equal(unknownMaterialSearch.status, 200);
    assert.deepEqual((await unknownMaterialSearch.json()).matches, []);
    const missingAttributes = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ specId: 'GABA-SPEC-001', price: 21800, quantity: 20, deliveryDays: 14 }) });
    assert.equal(missingAttributes.status, 422);
    assert.equal((await missingAttributes.json()).code, 'SPEC_ATTRIBUTES_REQUIRED');
    const mismatchedSpec = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ specId: 'GABA-SPEC-001', specAttributes: { ...GABA_SPEC_ATTRIBUTES, purity: '98% 이상' }, price: 21800, quantity: 20, deliveryDays: 14 }) });
    assert.equal(mismatchedSpec.status, 422);
    assert.equal((await mismatchedSpec.json()).code, 'SPEC_NOT_MATCHED');
    const fakeSupplierHeaders = { 'content-type': 'application/json', 'x-demo-role': 'SUPPLIER', 'x-raw-user-id': 'SIM-FAKE-SUPPLIER', 'x-raw-organization-id': 'SIM-FAKE-ORG' };
    const fakeEligibility = await fetch(`${base}/api/supplier/eligibility`, { headers: fakeSupplierHeaders });
    assert.equal(fakeEligibility.status, 200);
    assert.equal((await fakeEligibility.json()).eligibleToSubmitLot, false);
    const verificationRequest = await fetch(`${base}/api/supplier/verification-request`, { method: 'POST', headers: fakeSupplierHeaders, body: JSON.stringify({ businessRegistrationRef: 'vault://business-registration/fake', evidenceRefs: { businessRegistration: 'vault://business-registration/fake' } }) });
    assert.equal(verificationRequest.status, 200);
    assert.equal((await verificationRequest.json()).status, 'REQUESTED');
    const blockedLot = await fetch(`${base}/api/lots`, { method: 'POST', headers: fakeSupplierHeaders, body: JSON.stringify({ lotId: 'FAKE-LOT-001', specId: 'GABA-SPEC-001', availableQty: 100, askPrice: 21800, deliveryDays: 10 }) });
    assert.equal(blockedLot.status, 422);
    assert.equal((await blockedLot.json()).code, 'SUPPLIER_ORGANIZATION_NOT_VERIFIED');
    const supplierApproval = await fetch(`${base}/api/ops/approvals/SUPPLIER-VERIFY-SIM-FAKE-ORG`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'OWNER', 'x-raw-user-id': 'H-01' }, body: JSON.stringify({ decision: 'approve', note: '검토 진행 승인' }) });
    assert.equal(supplierApproval.status, 200);
    assert.equal((await supplierApproval.json()).approval.status, 'APPROVED');
    const postApprovalEligibility = await fetch(`${base}/api/supplier/eligibility`, { headers: fakeSupplierHeaders });
    assert.equal((await postApprovalEligibility.json()).latestVerificationRequest.status, 'UNDER_REVIEW');
    const readiness = await fetch(`${base}/api/readiness`, { headers: { 'x-demo-role': 'OPERATOR' } });
    assert.equal(readiness.status, 200);
    assert.equal((await readiness.json()).decision, 'NO_GO');
    const operations = await fetch(`${base}/api/ops/summary`, { headers: { 'x-demo-role': 'OPERATOR' } });
    assert.equal(operations.status, 200);
    const operationsBody = await operations.json();
    assert.equal(operationsBody.guardrails.tradeApprovalByAi, false);
    assert.equal(operationsBody.notificationOutbox.pending, 1);
    const notificationId = operationsBody.notificationOutbox.items[0].notificationId;
    const acknowledgedNotification = await fetch(`${base}/api/ops/notifications/${notificationId}/ack`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'OPERATOR', 'x-raw-user-id': 'SIM-OPERATOR-001' }, body: JSON.stringify({ note: '수신 확인' }) });
    assert.equal(acknowledgedNotification.status, 200);
    assert.equal((await acknowledgedNotification.json()).notification.state, 'ACKNOWLEDGED');
    const repeatedAcknowledgement = await fetch(`${base}/api/ops/notifications/${notificationId}/ack`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'OPERATOR', 'x-raw-user-id': 'SIM-OPERATOR-001' }, body: JSON.stringify({}) });
    assert.equal(repeatedAcknowledgement.status, 200);
    assert.equal((await repeatedAcknowledgement.json()).idempotent, true);
    const aiAcknowledgement = await fetch(`${base}/api/ops/notifications/${notificationId}/ack`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'AI', 'x-raw-user-id': 'AI-01' }, body: JSON.stringify({}) });
    assert.equal(aiAcknowledgement.status, 403);
    const buyerOperations = await fetch(`${base}/api/ops/summary`, { headers: { 'x-demo-role': 'BUYER' } });
    assert.equal(buyerOperations.status, 403);
    const aiApproval = await fetch(`${base}/api/ops/approvals/APPROVAL-API-001`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'AI' }, body: JSON.stringify({ decision: 'hold' }) });
    assert.equal(aiApproval.status, 403);
    const ownerApproval = await fetch(`${base}/api/ops/approvals/APPROVAL-API-001`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'OWNER', 'x-raw-user-id': 'H-01' }, body: JSON.stringify({ decision: 'hold', note: '추가 검토' }) });
    assert.equal(ownerApproval.status, 200);
    assert.equal((await ownerApproval.json()).approval.status, 'HELD');
    const approvalSummary = await fetch(`${base}/api/ops/summary`, { headers: { 'x-demo-role': 'OPERATOR' } });
    assert.equal(approvalSummary.status, 200);
    const approvalSummaryBody = await approvalSummary.json();
    assert.equal(approvalSummaryBody.approvalInbox.pending, 0);
    assert.equal(approvalSummaryBody.approvalInbox.items.find((item) => item.approvalId === 'APPROVAL-API-001').status, 'HELD');
    const repeatedOwnerApproval = await fetch(`${base}/api/ops/approvals/APPROVAL-API-001`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'OWNER', 'x-raw-user-id': 'H-01' }, body: JSON.stringify({ decision: 'hold' }) });
    assert.equal(repeatedOwnerApproval.status, 200);
    assert.equal((await repeatedOwnerApproval.json()).idempotent, true);
    const denied = await fetch(`${base}/api/orders/${order.order.orderId}/accept`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'BUYER' }, body: JSON.stringify({ lotId: 'GBA-KR-2407' }) });
    assert.equal(denied.status, 403);
    const evidenceResponse = await fetch(`${base}/api/evidence`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'SUPPLIER' }, body: JSON.stringify({ lotId: 'GBA-KR-AUTH', evidenceType: 'COA', documentVersion: 'v1', content: 'demo coa', expiresAt: '2027-01-01' }) });
    assert.equal(evidenceResponse.status, 201);
    const evidence = await evidenceResponse.json();
    const buyerReview = await fetch(`${base}/api/evidence/${evidence.evidenceId}/review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'BUYER' }, body: JSON.stringify({ decision: 'VALID' }) });
    assert.equal(buyerReview.status, 403);
    const operatorReview = await fetch(`${base}/api/evidence/${evidence.evidenceId}/review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'OPERATOR' }, body: JSON.stringify({ decision: 'VALID' }) });
    assert.equal(operatorReview.status, 200);
  } finally {
    simulationChild.kill();
  }
  console.log('api authorization tests: PASS');
} finally {
  if (child.exitCode === null) child.kill();
}
