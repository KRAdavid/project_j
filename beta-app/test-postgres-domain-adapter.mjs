import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

const ids = {
  org: '00000000-0000-0000-0000-000000000001',
  buyer: '00000000-0000-0000-0000-000000000002',
  supplier: '00000000-0000-0000-0000-000000000003',
  order: '00000000-0000-0000-0000-000000000004',
  trade: '00000000-0000-0000-0000-000000000005',
  reservation: '00000000-0000-0000-0000-000000000006',
};
const queries = [];
const client = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes("FROM specifications WHERE")) return { rows: [{ spec_id: 'GABA-SPEC-001', attributes: GABA_SPEC_ATTRIBUTES }] };
    if (sql.includes('INSERT INTO purchase_orders')) return { rows: [{ order_id: ids.order, buyer_organization_id: ids.org, spec_id: 'GABA-SPEC-001', spec_attributes: GABA_SPEC_ATTRIBUTES, state: 'SUBMITTED' }] };
    if (sql.includes('SELECT reserve_lot')) return { rows: [{ reservation_id: ids.reservation }] };
    if (sql.includes('FROM reservations WHERE reservation_id')) return { rows: [{ reservation_id: ids.reservation, order_id: ids.order, lot_id: 'LOT-001', quantity: '100', state: 'ACTIVE' }] };
    if (sql.includes('FROM purchase_orders WHERE')) return { rows: [{ order_id: ids.order, buyer_organization_id: ids.org, spec_id: 'GABA-SPEC-001', spec_attributes: GABA_SPEC_ATTRIBUTES, state: 'SUBMITTED' }] };
    if (sql.includes('FROM lots WHERE')) return { rows: [{ lot_id: 'LOT-001', spec_id: 'GABA-SPEC-001', supplier_organization_id: ids.org, state: 'VERIFIED_ELIGIBLE' }] };
    if (sql.includes('FROM evidences WHERE')) return { rows: [{ valid_count: 5 }] };
    if (sql.includes("FROM reservations WHERE order_id")) return { rows: [{ reservation_id: ids.reservation, quantity: '100' }] };
    if (sql.includes('FROM trades t JOIN') && sql.includes('JOIN reservations')) return { rows: [{ trade_id: ids.trade, order_id: ids.order, lot_id: 'LOT-001', state: 'CONFIRMED', supplier_organization_id: ids.org, price: '21800', quantity: '100', spec_id: 'GABA-SPEC-001', reservation_id: ids.reservation, reservation_state: 'ACTIVE' }] };
    if (sql.includes('UPDATE trades SET state =')) return { rows: [{ trade_id: ids.trade, state: 'DELIVERED' }] };
    if (sql.includes('INSERT INTO trade_inspections')) return { rows: [{ trade_id: ids.trade, reservation_id: ids.reservation, state: 'COMPLETED', spec_match: true, quality_pass: true }] };
    if (sql.includes('INSERT INTO trades')) return { rows: [{ trade_id: ids.trade, state: 'CONFIRMED', order_id: ids.order, lot_id: 'LOT-001' }] };
    if (sql.includes("FROM trades t JOIN purchase_orders po")) return { rows: [{ trade_id: ids.trade, state: 'COMPLETED', spec_id: 'GABA-SPEC-001', price: '21800', quantity: '100', currency: 'KRW', price_unit: 'KRW_PER_KG', quantity_unit: 'KG' }] };
    if (sql.includes('INSERT INTO price_observations')) return { rows: [{ observation_id: ids.trade }] };
    return { rows: [] };
  },
  release() {},
};
const pool = { async connect() { return client; } };
const adapter = new PostgresDomainAdapter(pool);

const submit = await adapter.submitOrder({
  buyerOrganizationId: ids.org,
  userId: ids.buyer,
  specId: 'GABA-SPEC-001',
  specAttributes: GABA_SPEC_ATTRIBUTES,
  bidPrice: 21800,
  requestedQuantity: 100,
  deliveryDeadline: '2026-10-01',
  actorKind: 'HUMAN',
  actorRef: ids.buyer,
  correlationId: 'CORR-001',
});
assert.equal(submit.order.order_id, ids.order);

const reservation = await adapter.reserveInventory({ orderId: ids.order, lotId: 'LOT-001', quantity: 100, idempotencyKey: 'IDEMP-001', actorRef: 'AI-08', correlationId: 'CORR-002' });
assert.equal(reservation.reservation.reservation_id, ids.reservation);

const confirmation = await adapter.confirmTrade({
  orderId: ids.order,
  supplierOrganizationId: ids.org,
  buyerOrganizationId: ids.org,
  supplierUserId: ids.supplier,
  buyerUserId: ids.buyer,
  lotId: 'LOT-001',
  price: 21800,
  quantity: 100,
  deliveryDeadline: '2026-10-01',
  specSnapshot: { specId: 'GABA-SPEC-001', attributes: GABA_SPEC_ATTRIBUTES },
  lotSnapshot: { lotId: 'LOT-001', quantity: 100 },
  evidenceSnapshot: { coa: 'VALID' },
  pretradeChecks: { specMatch: true, evidenceValid: true, lotTraceable: true, inventoryAvailable: true },
  tradeSnapshotHash: 'a'.repeat(64),
  actorRef: 'AI-02',
  correlationId: 'CORR-003',
});
assert.equal(confirmation.trade.trade_id, ids.trade);

const delivered = await adapter.markDelivered({ tradeId: ids.trade, supplierOrganizationId: ids.org, supplierUserId: ids.supplier, actorRef: ids.supplier, correlationId: 'CORR-DELIVER' });
assert.equal(delivered.trade.trade_id, ids.trade);
const inspected = await adapter.inspectTrade({ tradeId: ids.trade, operatorOrganizationId: ids.org, operatorUserId: ids.buyer, specMatch: true, qualityPass: true, note: '검수 통과', actorRef: ids.buyer, correlationId: 'CORR-INSPECT' });
assert.equal(inspected.inspection.state, 'COMPLETED');

const observation = await adapter.recordCompletedTradePrice({
  tradeId: ids.trade,
  specId: 'GABA-SPEC-001',
  price: 21800,
  quantity: 100,
  deliveryAndInspectionComplete: true,
  provenance: { source: 'completed-trade', evidenceId: 'E-001' },
  actorRef: 'AI-05',
  correlationId: 'CORR-004',
});
assert.equal(observation.observation.observation_id, ids.trade);
assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
assert.ok(queries.some(({ sql }) => sql === 'ROLLBACK') === false);
await assert.rejects(
  () => adapter.recordCompletedTradePrice({ tradeId: ids.trade, specId: 'GABA-SPEC-001', price: 21900, quantity: 100, deliveryAndInspectionComplete: true, provenance: { source: 'completed-trade' }, actorRef: 'AI-05', correlationId: 'CORR-PRICE-MISMATCH' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'PRICE_TRADE_VALUE_MISMATCH',
);
await assert.rejects(
  () => adapter.recordCompletedTradePrice({ tradeId: ids.trade, specId: 'GABA-SPEC-001', price: 21800, quantity: 100, quantityUnit: 'MT', deliveryAndInspectionComplete: true, provenance: { source: 'completed-trade' }, actorRef: 'AI-05', correlationId: 'CORR-TERMS-MISMATCH' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'TRADE_TERMS_MISMATCH',
);
assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
assert.ok(queries.some(({ sql }) => sql === 'ROLLBACK'));

await assert.rejects(
  () => adapter.submitOrder({ productType: 'FINANCIAL_INSTRUMENT' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'PHYSICAL_MATERIAL_ONLY',
);
await assert.rejects(
  () => adapter.submitOrder({ buyerOrganizationId: ids.org, userId: ids.buyer, specId: 'GABA-SPEC-001', bidPrice: 21800, requestedQuantity: 20, deliveryDeadline: '2026-10-01', actorRef: ids.buyer, correlationId: 'CORR-MISSING-SPEC-ATTRIBUTES' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'SPEC_ATTRIBUTES_REQUIRED',
);
await assert.rejects(
  () => adapter.submitOrder({ buyerOrganizationId: ids.org, userId: ids.buyer, specId: 'GABA-SPEC-001', specAttributes: { purity: '90%' }, bidPrice: 21800, requestedQuantity: 20, deliveryDeadline: '2026-10-01', actorRef: ids.buyer, correlationId: 'CORR-MISMATCH-SPEC-ATTRIBUTES' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'SPEC_ATTRIBUTES_MISMATCH',
);
await assert.rejects(
  () => adapter.recordCompletedTradePrice({ tradeId: ids.trade, specId: 'GABA-SPEC-001', price: 1, quantity: 1, provenance: {}, actorRef: 'AI-05', correlationId: 'CORR-005' }),
  (error) => error.code === 'DELIVERY_INSPECTION_REQUIRED',
);

const rollbackQueries = [];
const rollbackClient = {
  async query(sql, params = []) {
    rollbackQueries.push({ sql, params });
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes("FROM specifications WHERE")) return { rows: [{ spec_id: 'GABA-SPEC-001', attributes: GABA_SPEC_ATTRIBUTES }] };
    if (sql.includes('INSERT INTO purchase_orders')) throw new Error('simulated normalized write failure');
    return { rows: [] };
  },
  release() {},
};
const rollbackAdapter = new PostgresDomainAdapter({ async connect() { return rollbackClient; } });
await assert.rejects(
  () => rollbackAdapter.submitOrder({ buyerOrganizationId: ids.org, userId: ids.buyer, specId: 'GABA-SPEC-001', specAttributes: GABA_SPEC_ATTRIBUTES, bidPrice: 21800, requestedQuantity: 20, deliveryDeadline: '2026-10-01', actorRef: ids.buyer, correlationId: 'CORR-ROLLBACK' }),
  /simulated normalized write failure/,
);
assert.ok(rollbackQueries.some(({ sql }) => sql === 'ROLLBACK'));
assert.equal(rollbackQueries.some(({ sql }) => sql === 'COMMIT'), false);

console.log('postgres domain adapter tests: PASS');
