import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = {
  org: '00000000-0000-0000-0000-000000000051',
  user: '00000000-0000-0000-0000-000000000052',
  order: '00000000-0000-0000-0000-000000000053',
  trade: '00000000-0000-0000-0000-000000000054',
  reservation: '00000000-0000-0000-0000-000000000055',
};
const calls = [];
const client = {
  async query(sql, params = []) {
    calls.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [{ organization_id: ids.org, verified_at: '2026-01-01', verification_evidence: { source: 'test' } }] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM purchase_orders WHERE order_id')) return { rows: [{ order_id: ids.order, buyer_organization_id: ids.org, spec_id: 'GABA-SPEC-001', state: 'TRADE_CONFIRMED', bid_price: '21800', requested_quantity: '100' }] };
    if (sql.includes('FROM trades t JOIN purchase_orders')) return { rows: [{ trade_id: ids.trade, order_id: ids.order, lot_id: 'LOT-ACCEPT-IDEMP', state: 'CONFIRMED', supplier_organization_id: ids.org, spec_id: 'GABA-SPEC-001', price: '21800', quantity: '100' }] };
    if (sql.includes('FROM reservations WHERE order_id')) return { rows: [{ reservation_id: ids.reservation, quantity: '100', state: 'ACTIVE' }] };
    if (sql.includes('INSERT INTO trades')) throw new Error('accept retry must not insert a second trade');
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });
const firstRetry = await adapter.acceptOrder({
  orderId: ids.order,
  lotId: 'LOT-ACCEPT-IDEMP',
  supplierOrganizationId: ids.org,
  supplierUserId: ids.user,
  acceptedQuantity: 100,
  actorRef: ids.user,
  correlationId: 'ACCEPT-RETRY-001',
});
assert.equal(firstRetry.idempotent, true);
assert.equal(firstRetry.trade.trade_id, ids.trade);
assert.equal(calls.some(({ sql }) => sql.includes('INSERT INTO trades')), false);

await assert.rejects(
  () => adapter.acceptOrder({
    orderId: ids.order,
    lotId: 'LOT-ACCEPT-IDEMP',
    supplierOrganizationId: ids.org,
    supplierUserId: ids.user,
    acceptedQuantity: 99,
    actorRef: ids.user,
    correlationId: 'ACCEPT-RETRY-MISMATCH',
  }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'ACCEPT_RETRY_MISMATCH',
);

console.log('postgres accept idempotency tests: PASS');
