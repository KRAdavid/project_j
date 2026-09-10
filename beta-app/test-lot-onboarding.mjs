import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = 4178;
const cwd = fileURLToPath(new URL('.', import.meta.url));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, PORT: String(port), APP_ENV: 'simulation' }, stdio: 'ignore' });
const json = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const request = async (path, options) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await fetch(`${base}${path}`, options); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('lot onboarding server unavailable');
};

try {
  const lotId = `GBA-ONBOARD-${Date.now()}`;
  const supplierHeaders = { 'x-demo-role': 'SUPPLIER' };
  const operatorHeaders = { 'x-demo-role': 'OPERATOR' };
  const requiredTypes = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'];
  const blocked = await request('/api/lots', json({ lotId, supplier: '검증공급자', specId: 'GABA-SPEC-001', askPrice: 21500, availableQty: 100, deliveryDays: 7 }, supplierHeaders));
  assert.equal(blocked.status, 422);
  for (const evidenceType of requiredTypes) {
    const submitted = await request('/api/evidence', json({ lotId, evidenceType, documentVersion: 'v1', content: `${lotId}-${evidenceType}`, expiresAt: '2027-12-31' }, supplierHeaders));
    assert.equal(submitted.status, 201);
    const record = await submitted.json();
    const reviewed = await request(`/api/evidence/${record.evidenceId}/review`, json({ decision: 'VALID' }, operatorHeaders));
    assert.equal(reviewed.status, 200);
  }
  const created = await request('/api/lots', json({ lotId, supplier: '검증공급자', specId: 'GABA-SPEC-001', askPrice: 21500, availableQty: 100, deliveryDays: 7 }, supplierHeaders));
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.lot.status, 'VERIFIED_ELIGIBLE');
assert.equal(payload.evidenceCheck.preTradeEligible, true);
assert.equal(payload.lot.supplierOrganizationId, 'SIM-SUPPLIER-ORG');
  const state = await (await request('/api/state')).json();
  assert.ok(state.lots.some((lot) => lot.lotId === lotId));
  console.log('lot onboarding tests: PASS');
} finally {
  child.kill();
}
