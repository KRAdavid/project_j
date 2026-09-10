import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = {
  org: '00000000-0000-0000-0000-000000000021',
  buyer: '00000000-0000-0000-0000-000000000022',
  supplier: '00000000-0000-0000-0000-000000000023',
  order: '00000000-0000-0000-0000-000000000024',
};
const submittedAttributes = { purity: '99%' };
const changedAttributes = { purity: '98%' };
let materialMasterChanged = false;
const client = {
  async query(sql) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [{ organization_id: ids.org, verified_at: '2026-01-01', verification_evidence: { source: 'test' } }] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM specifications WHERE')) return { rows: [{ spec_id: 'GABA-SPEC-LOCK', attributes: materialMasterChanged ? changedAttributes : submittedAttributes }] };
    if (sql.includes('INSERT INTO purchase_orders')) return { rows: [{ order_id: ids.order, buyer_organization_id: ids.org, spec_id: 'GABA-SPEC-LOCK', spec_attributes: submittedAttributes, state: 'SUBMITTED' }] };
    if (sql.includes('FROM purchase_orders WHERE')) return { rows: [{ order_id: ids.order, buyer_organization_id: ids.org, spec_id: 'GABA-SPEC-LOCK', spec_attributes: submittedAttributes, state: 'SUBMITTED', bid_price: '21800', requested_quantity: '10', delivery_deadline: '2026-10-01' }] };
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });

const submitted = await adapter.submitOrder({ buyerOrganizationId: ids.org, userId: ids.buyer, specId: 'GABA-SPEC-LOCK', specAttributes: submittedAttributes, bidPrice: 21800, requestedQuantity: 10, deliveryDeadline: '2026-10-01', actorKind: 'HUMAN', actorRef: ids.buyer, correlationId: 'CORR-SPEC-LOCK-SUBMIT' });
assert.equal(submitted.order.order_id, ids.order);

materialMasterChanged = true;
await assert.rejects(
  () => adapter.acceptOrder({ orderId: ids.order, lotId: 'LOT-LOCK', supplierOrganizationId: ids.org, supplierUserId: ids.supplier, acceptedQuantity: 10, actorKind: 'HUMAN', actorRef: ids.supplier, correlationId: 'CORR-SPEC-LOCK-ACCEPT' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'SPEC_ATTRIBUTES_MISMATCH',
);

console.log('postgres domain adapter spec-lock tests: PASS');
