import assert from 'node:assert/strict';
import { GABA_SPEC_ATTRIBUTES, GABA_SPEC_ID, TradeEngine, TradeRuleError } from './trade-engine.mjs';

const expectRuleError = (operation, code) => {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof TradeRuleError);
    assert.equal(error.code, code);
    return true;
  });
};

const engine = new TradeEngine();

const firstOrder = engine.submitOrder({
  specId: GABA_SPEC_ID,
  specAttributes: GABA_SPEC_ATTRIBUTES,
  price: 21800,
  quantity: 1000,
  deliveryDays: 14,
  deliveryDate: '2026-09-22',
  idempotencyKey: 'test-order-001',
});

assert.equal(firstOrder.order.orderId, 'ORDER-00001');
assert.equal(firstOrder.order.status, 'BUY_ORDER_SUBMITTED');
assert.equal(firstOrder.order.preTradeGate.evidenceValid, true);
assert.equal(firstOrder.order.currency, 'KRW');
assert.equal(firstOrder.order.priceUnit, 'KRW_PER_KG');
assert.equal(firstOrder.order.quantityUnit, 'KG');
assert.equal(firstOrder.snapshot.orders.length, 1);
assert.equal(firstOrder.order.specAttributes.intendedUse, '기능성 식품 원료 개발');

expectRuleError(() => new TradeEngine().submitOrder({
  specId: GABA_SPEC_ID,
  specAttributes: { ...GABA_SPEC_ATTRIBUTES, purity: '98% 이상' },
  price: 21800,
  quantity: 20,
}), 'SPEC_NOT_MATCHED');

expectRuleError(() => new TradeEngine().submitOrder({
  specId: GABA_SPEC_ID,
  price: 21800,
  quantity: 20,
}), 'SPEC_ATTRIBUTES_REQUIRED');

const duplicateOrder = engine.submitOrder({
  specId: GABA_SPEC_ID,
  specAttributes: GABA_SPEC_ATTRIBUTES,
  price: 21800,
  quantity: 1000,
  deliveryDays: 14,
  idempotencyKey: 'test-order-001',
});

assert.equal(duplicateOrder.order.orderId, firstOrder.order.orderId);
assert.equal(duplicateOrder.snapshot.orders.length, 1, '멱등 재요청은 주문을 중복 생성하지 않아야 합니다.');

const confirmed = engine.acceptOrder(firstOrder.order.orderId, {
  lotId: 'GBA-KR-2407',
  idempotencyKey: 'test-accept-001',
});

assert.equal(confirmed.trade.tradeId, 'TRADE-00001');
assert.equal(confirmed.trade.currency, 'KRW');
assert.equal(confirmed.trade.priceUnit, 'KRW_PER_KG');
assert.equal(confirmed.trade.quantityUnit, 'KG');

expectRuleError(() => new TradeEngine().submitOrder({
  specId: GABA_SPEC_ID,
  specAttributes: GABA_SPEC_ATTRIBUTES,
  price: 21800,
  quantity: 20,
  quantityUnit: 'MT',
}), 'TRADE_TERMS_MISMATCH');

const legacySnapshot = new TradeEngine().snapshot();
delete legacySnapshot.lots[0].currency;
delete legacySnapshot.lots[0].priceUnit;
delete legacySnapshot.lots[0].quantityUnit;
const restoredLegacy = new TradeEngine(legacySnapshot);
const restoredOrder = restoredLegacy.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 20, deliveryDays: 14 });
assert.equal(restoredOrder.order.quantityUnit, 'KG');
assert.equal(confirmed.order.status, 'TRADE_CONFIRMED');
assert.equal(confirmed.trade.status, 'TRADE_CONFIRMED');
assert.equal(confirmed.trade.preTradeChecks.specMatch, true);
assert.equal(confirmed.trade.preTradeChecks.evidenceValid, true);
assert.equal(confirmed.trade.supplierOrganizationId, 'SIM-SUPPLIER-ORG');
assert.equal(confirmed.trade.tradeSnapshotHash.length, 64);
assert.equal(confirmed.trade.specSnapshot.deliveryCondition, '상온·밀봉 배송');
const orgGuardEngine = new TradeEngine();
const orgGuardOrder = orgGuardEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 20, deliveryDays: 14 });
assert.throws(() => orgGuardEngine.acceptOrder(orgGuardOrder.order.orderId, { lotId: 'GBA-KR-2407', supplierId: 'SIM-SUPPLIER-001', supplierOrganizationId: 'OTHER-ORG' }), (error) => error.code === 'SUPPLIER_ORGANIZATION_NOT_AUTHORIZED');
const tamperEngine = new TradeEngine();
const tamperOrder = tamperEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 20, deliveryDays: 14 });
const tamperTrade = tamperEngine.acceptOrder(tamperOrder.order.orderId, { lotId: 'GBA-KR-2407' }).trade;
tamperEngine.trades.get(tamperTrade.tradeId).price = 999;
assert.throws(() => tamperEngine.markDelivered(tamperTrade.tradeId), (error) => error.code === 'TRADE_SNAPSHOT_TAMPERED');
assert.equal(confirmed.snapshot.lots[0].availableQty, 200);
assert.equal(confirmed.snapshot.lots[0].reservedQty, 1000);
assert.equal(confirmed.snapshot.inventory.reservations.length, 1);
assert.equal(confirmed.snapshot.inventory.reservations[0].reservationId, firstOrder.order.orderId);

const duplicateAccept = engine.acceptOrder(firstOrder.order.orderId, {
  lotId: 'GBA-KR-2407',
  idempotencyKey: 'test-accept-001',
});

assert.equal(duplicateAccept.trade.tradeId, confirmed.trade.tradeId);
assert.equal(duplicateAccept.snapshot.trades.length, 1, '멱등 재요청은 체결을 중복 생성하지 않아야 합니다.');

const partialEngine = new TradeEngine();
const partialOrder = partialEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 1000, deliveryDays: 14, idempotencyKey: 'partial-order-001' });
const partialTrade = partialEngine.acceptOrder(partialOrder.order.orderId, { lotId: 'GBA-KR-2407', acceptedQuantity: 400, idempotencyKey: 'partial-accept-001' });
assert.equal(partialTrade.order.status, 'PARTIALLY_ACCEPTED');
assert.equal(partialTrade.order.remainingQuantity, 600);
assert.equal(partialTrade.trade.quantity, 400);
assert.equal(partialTrade.snapshot.lots[0].availableQty, 800);

const lifecycleEngine = new TradeEngine();
const lifecycleOrder = lifecycleEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14 });
const lifecycleTrade = lifecycleEngine.acceptOrder(lifecycleOrder.order.orderId, { lotId: 'GBA-KR-2407' });
assert.equal(lifecycleEngine.markDelivered(lifecycleTrade.trade.tradeId).trade.status, 'DELIVERED');
const fulfilled = lifecycleEngine.inspectTrade(lifecycleTrade.trade.tradeId, { specMatch: true, qualityPass: true });
assert.equal(fulfilled.trade.status, 'FULFILLED');
assert.equal(fulfilled.snapshot.inventory.inspections[0].status, 'INSPECTED');

const disputeEngine = new TradeEngine();
const disputeOrder = disputeEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14 });
const disputeTrade = disputeEngine.acceptOrder(disputeOrder.order.orderId, { lotId: 'GBA-KR-2407' });
const disputed = disputeEngine.inspectTrade(disputeTrade.trade.tradeId, { specMatch: false, qualityPass: true, note: '검수 불일치' });
assert.equal(disputed.trade.status, 'DISPUTED');
assert.equal(disputed.snapshot.lots[0].status, 'QUARANTINED');

const counterEngine = new TradeEngine();
const counterOrder = counterEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14, idempotencyKey: 'counter-order-001' });
const counter = counterEngine.counterOrder(counterOrder.order.orderId, { price: 21900, quantity: 200, deliveryDays: 14, idempotencyKey: 'counter-001' });
assert.equal(counter.order.status, 'COUNTERED');
assert.equal(counter.order.counterOffer.price, 21900);

const rejected = counterEngine.rejectOrder(counterOrder.order.orderId, { reason: '납기 조건 불일치', idempotencyKey: 'reject-001' });
assert.equal(rejected.order.status, 'REJECTED');

const expiredEngine = new TradeEngine();
const expiredOrder = expiredEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 20, deliveryDays: 14, expiresAt: '2020-01-01', idempotencyKey: 'expired-order-001' });
const expired = expiredEngine.expireOrder(expiredOrder.order.orderId);
assert.equal(expired.order.status, 'EXPIRED');

expectRuleError(() => engine.submitOrder({
  specId: 'UNCONFIRMED-SPEC',
  specAttributes: GABA_SPEC_ATTRIBUTES,
  price: 21800,
  quantity: 20,
}), 'SPEC_NOT_CONFIRMED');

expectRuleError(() => engine.submitOrder({
  specId: GABA_SPEC_ID,
  specAttributes: GABA_SPEC_ATTRIBUTES,
  price: 21800,
  quantity: 19,
}), 'INVENTORY_LIMIT');

expectRuleError(() => engine.submitOrder({
  specId: GABA_SPEC_ID,
  specAttributes: GABA_SPEC_ATTRIBUTES,
  price: 21800,
  quantity: 300,
}), 'NO_ELIGIBLE_OFFER');

expectRuleError(() => engine.acceptOrder('ORDER-99999', {
  lotId: 'GBA-KR-2407',
}), 'ORDER_NOT_FOUND');

console.log('trade-engine tests: PASS');
