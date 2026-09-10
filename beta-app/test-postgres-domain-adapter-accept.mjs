import assert from 'node:assert/strict';
import { PostgresDomainAdapter } from './postgres-domain-adapter.mjs';
import { GABA_SPEC_ATTRIBUTES } from './trade-engine.mjs';

const ids = {
  buyerOrg: '00000000-0000-0000-0000-000000000011',
  supplierOrg: '00000000-0000-0000-0000-000000000012',
  buyerUser: '00000000-0000-0000-0000-000000000013',
  supplierUser: '00000000-0000-0000-0000-000000000014',
  order: '00000000-0000-0000-0000-000000000015',
  reservation: '00000000-0000-0000-0000-000000000016',
  trade: '00000000-0000-0000-0000-000000000017',
};
const queries = [];
const evidenceTypes = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'];
const client = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [{ organization_id: ids.supplierOrg, verified_at: '2026-01-01', verification_evidence: { source: 'test' } }] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes("FROM specifications WHERE")) return { rows: [{ spec_id: 'GABA-SPEC-001', attributes: GABA_SPEC_ATTRIBUTES }] };
    if (sql.includes('SELECT * FROM purchase_orders')) return { rows: [{ order_id: ids.order, buyer_organization_id: ids.buyerOrg, spec_id: 'GABA-SPEC-001', spec_attributes: GABA_SPEC_ATTRIBUTES, state: 'SUBMITTED', bid_price: '21800', requested_quantity: '100', delivery_deadline: '2026-10-01' }] };
    if (sql.includes('FROM lots l JOIN organizations')) return { rows: [{ lot_id: 'LOT-001', supplier_organization_id: ids.supplierOrg, spec_id: 'GABA-SPEC-001', state: 'VERIFIED_ELIGIBLE', ask_price: '21800' }] };
    if (sql.includes('FROM trades t JOIN purchase_orders')) return { rows: [] };
    if (sql.includes('SELECT evidence_type')) return { rows: evidenceTypes.map((evidence_type) => ({ evidence_type, state: 'VALID', content_sha256: 'c'.repeat(64), storage_ref: `s3://evidence/${evidence_type}`, document_version: '1.0', expires_at: '2027-01-01' })) };
    if (sql.includes('SELECT reserve_lot')) return { rows: [{ reservation_id: ids.reservation }] };
    if (sql.includes('INSERT INTO trades')) return { rows: [{ trade_id: ids.trade, order_id: ids.order, lot_id: 'LOT-001', state: 'CONFIRMED', price: '21800', quantity: '100' }] };
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });
const result = await adapter.acceptOrder({ orderId: ids.order, lotId: 'LOT-001', supplierOrganizationId: ids.supplierOrg, supplierUserId: ids.supplierUser, acceptedQuantity: 100, actorKind: 'HUMAN', actorRef: ids.supplierUser, correlationId: 'CORR-ACCEPT-001' });
assert.equal(result.trade.trade_id, ids.trade);
assert.equal(result.reservation.reservation_id, ids.reservation);
assert.equal(result.idempotent, undefined);
const reserveIndex = queries.findIndex(({ sql }) => sql.includes('SELECT reserve_lot'));
const tradeIndex = queries.findIndex(({ sql }) => sql.includes('INSERT INTO trades'));
assert.ok(reserveIndex >= 0 && tradeIndex > reserveIndex);
assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
console.log('postgres domain adapter accept tests: PASS');
