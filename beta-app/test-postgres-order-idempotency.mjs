import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

const ids = {
  organization: '00000000-0000-0000-0000-000000000031',
  buyer: '00000000-0000-0000-0000-000000000032',
  order: '00000000-0000-0000-0000-000000000033',
};
let storedOrder = null;
let insertCount = 0;
const client = {
  async query(sql, params = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM specifications WHERE')) return { rows: [{ spec_id: 'GABA-SPEC-001', attributes: GABA_SPEC_ATTRIBUTES }] };
    if (sql.includes('FROM purchase_orders WHERE buyer_organization_id')) return { rows: storedOrder ? [storedOrder] : [] };
    if (sql.includes('INSERT INTO purchase_orders')) {
      insertCount += 1;
      storedOrder = {
        order_id: ids.order,
        buyer_organization_id: ids.organization,
        spec_id: 'GABA-SPEC-001',
        spec_attributes: GABA_SPEC_ATTRIBUTES,
        bid_price: '21800',
        requested_quantity: '100',
        delivery_deadline: '2026-10-01',
        partial_fill_allowed: true,
        idempotency_key: params[10],
        state: 'SUBMITTED',
      };
      return { rows: [storedOrder] };
    }
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });
const base = {
  buyerOrganizationId: ids.organization,
  userId: ids.buyer,
  specId: 'GABA-SPEC-001',
  specAttributes: GABA_SPEC_ATTRIBUTES,
  bidPrice: 21800,
  requestedQuantity: 100,
  deliveryDeadline: '2026-10-01',
  idempotencyKey: 'ORDER-IDEMP-001',
  actorKind: 'HUMAN',
  actorRef: ids.buyer,
};
const first = await adapter.submitOrder({ ...base, correlationId: 'CORR-IDEMP-1' });
const second = await adapter.submitOrder({ ...base, correlationId: 'CORR-IDEMP-2' });
assert.equal(first.idempotent, false);
assert.equal(second.idempotent, true);
assert.equal(second.order.order_id, first.order.order_id);
assert.equal(insertCount, 1);
assert.equal(first.order.idempotency_key, base.idempotencyKey);
await assert.rejects(
  () => adapter.submitOrder({ ...base, bidPrice: 21900, correlationId: 'CORR-IDEMP-3' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'IDEMPOTENCY_KEY_REUSED',
);
console.log('postgres order idempotency tests: PASS');
