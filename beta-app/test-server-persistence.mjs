import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

const port = 4176;
const filePath = join(tmpdir(), `raw-material-server-${Date.now()}.sqlite`);
const documentRoot = join(tmpdir(), `raw-material-server-docs-${Date.now()}`);
const appRoot = fileURLToPath(new URL('.', import.meta.url));
const children = new Set();

const waitForHealth = async (child) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  children.delete(child);
  throw new Error('서버가 제한시간 내에 시작되지 않았습니다.');
};

const startServer = async () => {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'server.mjs'], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(port), PERSISTENCE_MODE: 'sqlite', PERSISTENCE_FILE: filePath, DOCUMENT_STORAGE_ROOT: documentRoot, ALLOW_TEST_SHUTDOWN: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('error', (error) => { throw error; });
  child.stdout.resume();
  child.stderr.resume();
  await waitForHealth(child);
  return child;
};

const request = async (path, options = {}) => (await fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(3000) })).json();
const jsonOptions = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const waitForExit = async (child, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) await wait(100);
  return child.exitCode !== null;
};
const stopServer = async (child) => {
  if (child.exitCode !== null) { children.delete(child); return; }
  try { await fetch(`http://127.0.0.1:${port}/api/test/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1000) }); } catch {}
  if (await waitForExit(child)) { children.delete(child); return; }
  child.kill('SIGINT');
  if (await waitForExit(child)) { children.delete(child); return; }
  child.kill();
  if (!(await waitForExit(child, 2000))) throw new Error('서버가 종료되지 않아 SQLite 파일을 안전하게 정리할 수 없습니다.');
  children.delete(child);
};

try {
  const first = await startServer();
  const health = await request('/api/health');
  assert.equal(health.persistence.runtimeMode, 'sqlite');

  const persistedEvidence = await request('/api/evidence', jsonOptions({ lotId: 'LOT-PERSIST', evidenceType: 'COA', documentVersion: 'v1', content: 'persisted coa', expiresAt: '2027-12-31' }));
  assert.ok(persistedEvidence.evidenceId);

  const orderResponse = await request('/api/orders', jsonOptions({ specId: 'GABA-SPEC-001', specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14, idempotencyKey: 'server-order-001' }));
  const accepted = await request(`/api/orders/${orderResponse.order.orderId}/accept`, jsonOptions({ lotId: 'GBA-KR-2407', idempotencyKey: 'server-accept-001' }));
  await stopServer(first);

  const second = await startServer();
  const recovered = await request('/api/state');
  assert.equal(recovered.orders[0].status, 'TRADE_CONFIRMED');
  assert.equal(recovered.trades.length, 1);
  assert.equal(recovered.lots[0].availableQty, 1000);
  const recoveredEvidence = await request('/api/evidence?lotId=LOT-PERSIST', { headers: { 'x-raw-role': 'OPERATOR' } });
  assert.equal(recoveredEvidence.length, 1);
  assert.equal(recoveredEvidence[0].contentSha256.length, 64);
  const next = await request('/api/orders', jsonOptions({ specId: 'GABA-SPEC-001', specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14, idempotencyKey: 'server-order-002' }));
  assert.equal(next.order.orderId, 'ORDER-00002');
  await stopServer(second);
  console.log('server persistence recovery tests: PASS');
} finally {
  for (const child of [...children]) {
    try { await stopServer(child); } catch { try { child.kill(); } catch {} }
  }
  await rm(filePath, { force: true, maxRetries: 50, retryDelay: 200 });
  await rm(documentRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
}
