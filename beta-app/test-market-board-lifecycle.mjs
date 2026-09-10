import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

const port = Number(process.env.MARKET_BOARD_LIFECYCLE_PORT || (4300 + (process.pid % 1000)));
const cwd = fileURLToPath(new URL('.', import.meta.url));
const opsRoot = await mkdtemp(join(tmpdir(), 'raw-material-market-board-'));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd,
  env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', OPS_ROOT: opsRoot },
  stdio: 'ignore',
});

const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const request = async (path, options) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await fetch(`${base}${path}`, options); } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('market board lifecycle server unavailable');
};

const board = async () => {
  const response = await request('/api/market-board?specId=GABA-SPEC-001', { headers: { 'x-demo-role': 'BUYER' } });
  assert.equal(response.status, 200);
  return response.json();
};

try {
  const before = await board();
  assert.equal(before.dataStatus, 'SERVER_VERIFIED_OFFERS');
  assert.equal(before.activityStatus, 'NO_COMPLETED_TRADES');
  assert.equal(before.recentTrades.length, 0);
  assert.equal(before.asks.length, 1);
  assert.equal(before.asks[0].availableQty, 1200);

  const orderResponse = await request('/api/orders', json({
    specId: 'GABA-SPEC-001',
    specAttributes: GABA_SPEC_ATTRIBUTES,
    price: 21800,
    quantity: 200,
    deliveryDays: 14,
  }));
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();

  const acceptedResponse = await request(`/api/orders/${order.order.orderId}/accept`, json(
    { lotId: 'GBA-KR-2407' },
    { 'x-demo-role': 'SUPPLIER' },
  ));
  assert.equal(acceptedResponse.status, 200);
  const accepted = await acceptedResponse.json();
  const afterAccept = await board();
  assert.equal(afterAccept.activityStatus, 'NO_COMPLETED_TRADES');
  assert.equal(afterAccept.recentTrades.length, 0);
  assert.equal(afterAccept.asks[0].availableQty, 1000);

  const deliveredResponse = await request(`/api/trades/${accepted.trade.tradeId}/deliver`, json(
    {},
    { 'x-demo-role': 'SUPPLIER' },
  ));
  assert.equal(deliveredResponse.status, 200);
  assert.equal((await deliveredResponse.json()).trade.status, 'DELIVERED');

  const inspectedResponse = await request(`/api/trades/${accepted.trade.tradeId}/inspect`, json(
    { specMatch: true, qualityPass: true },
    { 'x-demo-role': 'OPERATOR' },
  ));
  assert.equal(inspectedResponse.status, 200);
  assert.equal((await inspectedResponse.json()).trade.status, 'FULFILLED');

  const afterFulfillment = await board();
  assert.equal(afterFulfillment.activityStatus, 'SERVER_VERIFIED_COMPLETED_TRADES');
  assert.equal(afterFulfillment.recentTrades.length, 1);
  assert.equal(afterFulfillment.recentTrades[0].price, 21800);
  assert.equal(afterFulfillment.recentTrades[0].quantity, 200);
  assert.equal(afterFulfillment.recentTrades[0].disclosureStatus, 'COMPLETED_PHYSICAL_TRADE');
  assert.equal(afterFulfillment.asks.length, 1, '부분 체결 후 잔여 재고는 계속 매물로 노출되어야 합니다.');
  assert.equal(afterFulfillment.asks[0].availableQty, 1000, '검수 완료된 주문 수량만 차감되고 잔여 재고는 보존되어야 합니다.');

  const priceIndexResponse = await request('/api/price-index?specId=GABA-SPEC-001', { headers: { 'x-demo-role': 'BUYER' } });
  assert.equal(priceIndexResponse.status, 200);
  const priceIndex = await priceIndexResponse.json();
  assert.equal(priceIndex.sampleSize, 1);
  assert.equal(priceIndex.status, 'UNAVAILABLE');
  assert.equal(priceIndex.reason, 'INSUFFICIENT_COMPLETED_TRADES');
  assert.deepEqual(priceIndex.priceSeries, [{ fulfilledAt: priceIndex.priceSeries[0].fulfilledAt, price: 21800 }]);
  assert.ok(priceIndex.priceSeries.every((point) => !Object.prototype.hasOwnProperty.call(point, 'supplierId')));

  console.log('market board lifecycle tests: PASS');
} finally {
  child.kill();
  await rm(opsRoot, { recursive: true, force: true });
}

