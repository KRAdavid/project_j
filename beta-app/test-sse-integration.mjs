import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const portProbe = createNetServer();
await new Promise((resolveProbe, rejectProbe) => {
  portProbe.once('error', rejectProbe);
  portProbe.listen(0, '127.0.0.1', resolveProbe);
});
const port = portProbe.address().port;
await new Promise((resolveProbe, rejectProbe) => portProbe.close((error) => error ? rejectProbe(error) : resolveProbe()));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), ALLOW_TEST_SHUTDOWN: 'true' }, stdio: 'ignore' });

const request = async (path, options) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { return await fetch(`${base}${path}`, options); } catch { await wait(100); }
  }
  throw new Error('통합 테스트 서버에 연결할 수 없습니다.');
};

try {
  const stream = await request('/api/events');
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /event: snapshot/);
  assert.match(first, /SIMULATED_BACKEND/);

  const orderResponse = await request('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ specId: 'GABA-SPEC-001', specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14, idempotencyKey: 'sse-order-001' }),
  });
  const order = await orderResponse.json();
  assert.equal(orderResponse.status, 201);
  const event = decoder.decode((await reader.read()).value);
  assert.match(event, /event: ledger/);
  assert.match(event, /ORDER_SUBMITTED/);

  const acceptResponse = await request(`/api/orders/${order.order.orderId}/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lotId: 'GBA-KR-2407', idempotencyKey: 'sse-accept-001' }),
  });
  assert.equal(acceptResponse.status, 200);
  const tradeEvent = decoder.decode((await reader.read()).value);
  assert.match(tradeEvent, /event: ledger/);
  assert.match(tradeEvent, /TRADE_CONFIRMED/);
  await reader.cancel();
  console.log('sse integration tests: PASS');
} finally {
  try { await request('/api/test/shutdown', { method: 'POST' }); } catch {}
  if (child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(1000)]);
    if (child.exitCode === null) child.kill();
  }
}
