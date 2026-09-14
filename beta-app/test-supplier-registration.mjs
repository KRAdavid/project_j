import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

  const account = await request('/api/account/session', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '220-81-62517', email: 'supplier@example.com' }) });
  assert.equal(account.status, 201);
  const accountPayload = await account.json();
  assert.equal(accountPayload.status, 'ACCOUNT_REGISTERED');
  assert.equal(accountPayload.account.maskedBusinessRegistrationNumber, '220-81-****7');

  const registration = await request('/api/supplier/registration', { method: 'POST', body: JSON.stringify({ businessRegistrationNumber: '220-81-62517', email: 'supplier@example.com', legalName: 'GABA 공급기업' }) });
  assert.equal(registration.status, 201);
  const registrationPayload = await registration.json();
  assert.equal(registrationPayload.status, 'AUTO_REGISTERED');
  assert.equal(registrationPayload.idempotent, false);

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
