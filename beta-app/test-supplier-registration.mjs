import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSimulationBusinessVerification, verifyOfficialBusinessRegistration } from './business-verification.mjs';

const port = 4179;
const cwd = fileURLToPath(new URL('.', import.meta.url));
const child = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', PERSISTENCE_MODE: 'memory' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
const headers = { 'Content-Type': 'application/json', 'X-Raw-Role': 'SUPPLIER', 'X-Raw-User-Id': 'SIM-TEST-SUPPLIER-001', 'X-Raw-Organization-Id': 'SIM-TEST-SUPPLIER-ORG' };
const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/materials`);
      ready = response.status === 200;
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'supplier registration test server did not start');

  const invalid = await request('/api/account/session', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '123-45-67890', email: 'supplier@example.com' }) });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).code, 'BUSINESS_REGISTRATION_INVALID');

  const noAccountRegistration = await request('/api/supplier/registration', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '220-81-62517', email: 'supplier@example.com', legalName: '세션 없는 공급기업' }) });
  assert.equal(noAccountRegistration.status, 422);
  assert.equal((await noAccountRegistration.json()).code, 'ACCOUNT_SESSION_REQUIRED');

  const account = await request('/api/account/session', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '220-81-62517', email: 'supplier@example.com' }) });
  assert.equal(account.status, 201);
  const accountPayload = await account.json();
  assert.equal(accountPayload.status, 'ACCOUNT_REGISTERED');
  assert.equal(accountPayload.account.maskedBusinessRegistrationNumber, '220-81-****7');
  assert.equal(accountPayload.account.businessVerification.status, 'FORMAT_VALID');
  assert.equal(accountPayload.account.businessVerification.verified, false);
  headers['X-Raw-User-Id'] = accountPayload.account.userId;
  headers['X-Raw-Organization-Id'] = accountPayload.account.organizationId;

  const formatCheck = createSimulationBusinessVerification({ businessRegistrationNumber: '220-81-62517' });
  assert.equal(formatCheck.status, 'FORMAT_VALID');
  assert.equal(formatCheck.verified, false);
  await assert.rejects(() => verifyOfficialBusinessRegistration({ businessRegistrationNumber: '220-81-62517' }), { code: 'BUSINESS_REGISTRATION_PROVIDER_REQUIRED' });
  const official = await verifyOfficialBusinessRegistration({ businessRegistrationNumber: '220-81-62517', provider: { verify: async ({ businessRegistrationNumber }) => ({ verified: true, providerStatus: 'ACTIVE', providerReference: `REF-${businessRegistrationNumber}` }) } });
  assert.equal(official.status, 'OFFICIALLY_VERIFIED');
  assert.equal(official.verified, true);
  assert.equal(official.mode, 'OFFICIAL_PROVIDER');
  await assert.rejects(() => verifyOfficialBusinessRegistration({ businessRegistrationNumber: '220-81-62517', provider: { verify: async () => ({ verified: false, providerStatus: 'CLOSED' }) } }), { code: 'BUSINESS_REGISTRATION_NOT_VERIFIED' });

  const invalidRegistrationEmail = await request('/api/supplier/registration', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '220-81-62517', email: 'not-an-email', legalName: '잘못된 공급기업' }) });
  assert.equal(invalidRegistrationEmail.status, 422);
  assert.equal((await invalidRegistrationEmail.json()).code, 'BUSINESS_EMAIL_INVALID');

  const invalidCoaBytes = Buffer.from('not-a-pdf');
  const invalidCoaSha256 = createHash('sha256').update(invalidCoaBytes).digest('hex');
  const invalidUpload = await request('/api/supplier/precheck-document', { method: 'POST', body: JSON.stringify({ fileName: 'spoofed-coa.pdf', contentType: 'application/pdf', contentBase64: invalidCoaBytes.toString('base64'), contentSha256: invalidCoaSha256, idempotencyKey: `supplier-document-${invalidCoaSha256}` }) });
  assert.equal(invalidUpload.status, 422);
  assert.equal((await invalidUpload.json()).code, 'DOCUMENT_SIGNATURE_MISMATCH');
  const coaBytes = Buffer.from('%PDF-1.7\nGABA COA fixture');
  const coaSha256 = createHash('sha256').update(coaBytes).digest('hex');
  const documentUpload = await request('/api/supplier/precheck-document', { method: 'POST', body: JSON.stringify({ fileName: 'coa-gaba-2026-07.pdf', contentType: 'application/pdf', contentBase64: coaBytes.toString('base64'), contentSha256: coaSha256, idempotencyKey: `supplier-document-${coaSha256}` }) });
  assert.equal(documentUpload.status, 201);
  const documentPayload = await documentUpload.json();
  assert.equal(documentPayload.status, 'DOCUMENT_STORED');
  assert.equal(documentPayload.document.contentSha256, coaSha256);
  const evidenceOnlyPrecheck = await request('/api/supplier/precheck', { method: 'POST', body: JSON.stringify({ material: 'GABA', coaDocumentNumber: 'COA-GABA-2026-07', coaFileName: 'coa-gaba-2026-07.pdf', coaFileSize: coaBytes.length, coaFileSha256: coaSha256, coaStorageRef: documentPayload.document.storageRef, inventoryQuantity: 100, unit: 'KG', expiry: '2099-12-31', priceTiers: [], reviewScope: 'EVIDENCE_ONLY', idempotencyKey: 'supplier-evidence-only-001' }) });
  assert.equal(evidenceOnlyPrecheck.status, 201);
  const evidenceOnlyPayload = await evidenceOnlyPrecheck.json();
  assert.equal(evidenceOnlyPayload.review.reviewScope, 'EVIDENCE_ONLY');
  assert.equal(evidenceOnlyPayload.review.ready, true, 'COA·재고 증빙 입력만으로도 자동 사전검토가 완료되어야 합니다.');
  const precheckInput = { material: 'GABA', coaDocumentNumber: 'COA-GABA-2026-07', coaFileName: 'coa-gaba-2026-07.pdf', coaFileSize: coaBytes.length, coaFileSha256: coaSha256, coaStorageRef: documentPayload.document.storageRef, inventoryQuantity: 100, unit: 'KG', expiry: '2099-12-31', priceTiers: [{ quantity: 20, price: 21800 }], idempotencyKey: 'supplier-precheck-test-001' };
  const precheck = await request('/api/supplier/precheck', { method: 'POST', body: JSON.stringify(precheckInput) });
  assert.equal(precheck.status, 201);
  const precheckPayload = await precheck.json();
  assert.equal(precheckPayload.status, 'PRECHECK_REVIEWED');
  assert.equal(precheckPayload.review.ready, true);
  assert.equal(precheckPayload.review.mode, 'SIMULATION_AI_PRECHECK');
  const missingStorage = await request('/api/supplier/precheck', { method: 'POST', body: JSON.stringify({ ...precheckInput, idempotencyKey: 'supplier-precheck-missing-storage', coaStorageRef: 'memory://evidence/not-the-uploaded-document' }) });
  assert.equal(missingStorage.status, 422);
  assert.equal((await missingStorage.json()).code, 'COA_STORAGE_REFERENCE_MISMATCH');
  const precheckRepeat = await request('/api/supplier/precheck', { method: 'POST', body: JSON.stringify(precheckInput) });
  assert.equal(precheckRepeat.status, 200);
  assert.equal((await precheckRepeat.json()).idempotent, true);
  const mismatchedPrecheck = await request('/api/supplier/precheck', { method: 'POST', body: JSON.stringify({ ...precheckInput, priceTiers: [{ quantity: 20, price: 21900 }] }) });
  assert.equal(mismatchedPrecheck.status, 422);
  assert.equal((await mismatchedPrecheck.json()).code, 'IDEMPOTENCY_KEY_REUSE_MISMATCH');

  const registration = await request('/api/supplier/registration', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '220-81-62517', email: 'supplier@example.com', legalName: 'GABA 공급기업' }) });
  assert.equal(registration.status, 201);
  const registrationPayload = await registration.json();
  assert.equal(registrationPayload.status, 'AUTO_REGISTERED');
  assert.equal(registrationPayload.idempotent, false);
  assert.equal(registrationPayload.registration.businessVerification.status, 'FORMAT_VALID');
  assert.equal(registrationPayload.registration.businessVerification.verified, false);

  const repeat = await request('/api/supplier/registration', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '2208162517', email: 'supplier@example.com' }) });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).idempotent, true);

  const eligibility = await request('/api/supplier/eligibility');
  const eligibilityPayload = await eligibility.json();
  assert.equal(eligibility.status, 200);
  assert.equal(eligibilityPayload.organizationRegistered, true);
  assert.equal(eligibilityPayload.activeSupplierMembership, true);
  assert.equal(eligibilityPayload.organizationVerified, false);
  assert.equal(eligibilityPayload.eligibleToSubmitLot, false);

  console.log('supplier registration tests: PASS');
} finally {
  child.kill();
}

