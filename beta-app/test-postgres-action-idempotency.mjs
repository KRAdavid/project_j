import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = {
  org: '00000000-0000-0000-0000-000000000061',
  user: '00000000-0000-0000-0000-000000000062',
  order: '00000000-0000-0000-0000-000000000063',
  evidence: '00000000-0000-0000-0000-000000000064',
};

const counterOffer = {
  specId: 'GABA-SPEC-001', price: 22000, quantity: 50, deliveryDays: 7,
  currency: 'KRW', priceUnit: 'KRW_PER_KG', quantityUnit: 'KG', lotId: 'LOT-ACTION', supplierOrganizationId: ids.org,
};

const makeClient = ({ orderState, evidenceState = null, reviewedBy = null }) => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [{ organization_id: ids.org, verified_at: '2026-01-01', verification_evidence: { source: 'test' } }] };
      if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
      if (sql.includes('FROM purchase_orders WHERE order_id')) return { rows: [{ order_id: ids.order, state: orderState, spec_id: 'GABA-SPEC-001', counter_offer: orderState === 'COUNTERED' ? counterOffer : null, expires_at: '2026-01-01T00:00:00.000Z' }] };
      if (sql.includes('FROM evidences WHERE evidence_id')) return { rows: [{ evidence_id: ids.evidence, state: evidenceState, reviewed_by: reviewedBy, lot_id: 'LOT-ACTION', evidence_type: 'COA', content_sha256: 'a'.repeat(64), storage_ref: 's3://test/coa', document_version: '1.0' }] };
      if (sql.includes('UPDATE purchase_orders')) throw new Error('terminal action retry must not update the order');
      if (sql.includes('UPDATE evidences')) throw new Error('terminal review retry must not update evidence');
      return { rows: [] };
    },
    release() {},
  };
  return { client, calls };
};

const counter = makeClient({ orderState: 'COUNTERED' });
const counterAdapter = new PostgresDomainAdapter({ async connect() { return counter.client; } });
const counterRetry = await counterAdapter.counterOrder({
  orderId: ids.order, supplierOrganizationId: ids.org, supplierUserId: ids.user, ...counterOffer,
  actorRef: ids.user, correlationId: 'COUNTER-RETRY-001',
});
assert.equal(counterRetry.idempotent, true);
assert.equal(counterRetry.order.order_id, ids.order);
await assert.rejects(
  () => counterAdapter.counterOrder({
    orderId: ids.order, supplierOrganizationId: ids.org, supplierUserId: ids.user, ...counterOffer, price: 22100,
    actorRef: ids.user, correlationId: 'COUNTER-RETRY-MISMATCH',
  }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'COUNTER_RETRY_MISMATCH',
);

const rejected = makeClient({ orderState: 'REJECTED' });
const rejectedAdapter = new PostgresDomainAdapter({ async connect() { return rejected.client; } });
assert.equal((await rejectedAdapter.rejectOrder({ orderId: ids.order, supplierOrganizationId: ids.org, supplierUserId: ids.user, actorRef: ids.user, correlationId: 'REJECT-RETRY-001' })).idempotent, true);
assert.equal(rejected.calls.some(({ sql }) => sql.includes('UPDATE purchase_orders')), false);

const expired = makeClient({ orderState: 'EXPIRED' });
const expiredAdapter = new PostgresDomainAdapter({ async connect() { return expired.client; } });
assert.equal((await expiredAdapter.expireOrder({ orderId: ids.order, actorRef: 'SYSTEM', correlationId: 'EXPIRE-RETRY-001' })).idempotent, true);
assert.equal(expired.calls.some(({ sql }) => sql.includes('UPDATE purchase_orders')), false);

const reviewed = makeClient({ orderState: 'SUBMITTED', evidenceState: 'VALID', reviewedBy: ids.user });
const reviewedAdapter = new PostgresDomainAdapter({ async connect() { return reviewed.client; } });
const evidenceRetry = await reviewedAdapter.reviewEvidence({ evidenceId: ids.evidence, operatorOrganizationId: ids.org, operatorUserId: ids.user, decision: 'VALID', actorRef: ids.user, correlationId: 'EVIDENCE-RETRY-001' });
assert.equal(evidenceRetry.idempotent, true);
await assert.rejects(
  () => reviewedAdapter.reviewEvidence({ evidenceId: ids.evidence, operatorOrganizationId: ids.org, operatorUserId: ids.user, decision: 'REJECTED', actorRef: ids.user, correlationId: 'EVIDENCE-RETRY-MISMATCH' }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'EVIDENCE_REVIEW_RETRY_MISMATCH',
);
assert.equal(reviewed.calls.some(({ sql }) => sql.includes('UPDATE evidences')), false);

console.log('postgres action idempotency tests: PASS');
