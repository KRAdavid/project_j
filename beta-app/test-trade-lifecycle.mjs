import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

const port = 4179;
const cwd = fileURLToPath(new URL('.', import.meta.url));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, PORT: String(port), APP_ENV: 'simulation' }, stdio: 'ignore' });
const json = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const request = async (path, options) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await fetch(`${base}${path}`, options); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('trade lifecycle server unavailable');
};

try {
  const orderResponse = await request('/api/orders', json({ specId: 'GABA-SPEC-001', specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14 }));
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  const acceptResponse = await request(`/api/orders/${order.order.orderId}/accept`, json({ lotId: 'GBA-KR-2407' }, { 'x-demo-role': 'SUPPLIER' }));
  assert.equal(acceptResponse.status, 200);
  const accepted = await acceptResponse.json();
  const deliverResponse = await request(`/api/trades/${accepted.trade.tradeId}/deliver`, json({}, { 'x-demo-role': 'SUPPLIER' }));
  assert.equal(deliverResponse.status, 200);
  assert.equal((await deliverResponse.json()).trade.status, 'DELIVERED');
  const inspectResponse = await request(`/api/trades/${accepted.trade.tradeId}/inspect`, json({ specMatch: true, qualityPass: true }, { 'x-demo-role': 'OPERATOR' }));
  assert.equal(inspectResponse.status, 200);
  assert.equal((await inspectResponse.json()).trade.status, 'FULFILLED');
  console.log('trade lifecycle tests: PASS');
} finally {
  child.kill();
}
