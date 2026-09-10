import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = { org: '00000000-0000-0000-0000-000000000041', supplier: '00000000-0000-0000-0000-000000000042', operator: '00000000-0000-0000-0000-000000000043' };
const types = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'];
const bundle = types.map((evidenceType) => ({ evidenceType, documentVersion: '1.0', contentSha256: 'a'.repeat(64), storageRef: `s3://raw-material/${evidenceType}`, expiresAt: '2027-01-01' }));
const draftQueries = [];
const draftClient = {
  async query(sql, params = []) {
    draftQueries.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [{ organization_id: ids.org, verified_at: '2026-01-01', verification_evidence: { source: 'test' } }] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes("FROM specifications WHERE")) return { rows: [{ spec_id: 'GABA-SPEC-001' }] };
    if (sql.includes('INSERT INTO lots')) return { rows: [{ lot_id: 'LOT-DRAFT', supplier_organization_id: ids.org, spec_id: 'GABA-SPEC-001', state: 'PENDING_VERIFICATION', total_quantity: '1000', available_quantity: '1000', reserved_quantity: '0', ask_price: '21800', delivery_days: 10 }] };
    if (sql.includes('INSERT INTO evidences')) return { rows: [{ evidence_id: `E-${draftQueries.length}`, lot_id: 'LOT-DRAFT', evidence_type: params[3], document_version: params[4], content_sha256: params[5], storage_ref: params[6], state: 'PENDING', organization_id: ids.org, submitted_by: ids.supplier }] };
    return { rows: [] };
  },
  release() {},
};
const draft = await new PostgresDomainAdapter({ async connect() { return draftClient; } }).registerLotDraft({ lotId: 'LOT-DRAFT', supplierOrganizationId: ids.org, supplierUserId: ids.supplier, specId: 'GABA-SPEC-001', availableQty: 1000, askPrice: 21800, deliveryDays: 10, evidenceBundle: bundle, actorKind: 'HUMAN', actorRef: ids.supplier, correlationId: 'LOT-DRAFT-001' });
assert.equal(draft.lot.status, 'PENDING_VERIFICATION');
assert.equal(draft.offer, null);
assert.equal(draft.evidence.length, 5);
assert.equal(draftQueries.some(({ sql }) => sql.includes("'VALID'::evidence_state")), false);

const reviewQueries = [];
const reviewClient = {
  async query(sql, params = []) {
    reviewQueries.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [{ organization_id: ids.org, verified_at: '2026-01-01', verification_evidence: { source: 'test' } }] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('SELECT * FROM evidences')) return { rows: [{ evidence_id: 'E-1', lot_id: 'LOT-DRAFT', evidence_type: 'COA', state: 'PENDING', organization_id: ids.org, submitted_by: ids.supplier }] };
    if (sql.includes('UPDATE evidences SET')) return { rows: [{ evidence_id: 'E-1', lot_id: 'LOT-DRAFT', evidence_type: 'COA', document_version: '1.0', content_sha256: 'a'.repeat(64), storage_ref: 's3://raw-material/COA', state: 'VALID', organization_id: ids.org, submitted_by: ids.supplier, reviewed_by: ids.operator }] };
    if (sql.includes('count(DISTINCT evidence_type)')) return { rows: [{ valid_count: 5, expires_at: '2027-01-01' }] };
    if (sql.includes('UPDATE lots SET state')) return { rows: [{ lot_id: 'LOT-DRAFT', supplier_organization_id: ids.org, spec_id: 'GABA-SPEC-001', state: 'VERIFIED_ELIGIBLE', total_quantity: '1000', available_quantity: '1000', reserved_quantity: '0', ask_price: '21800', delivery_days: 10 }] };
    if (sql.includes('INSERT INTO offers')) return { rows: [{ offer_id: 'OFFER-DRAFT', lot_id: 'LOT-DRAFT', state: 'VISIBLE' }] };
    return { rows: [] };
  },
  release() {},
};
const reviewed = await new PostgresDomainAdapter({ async connect() { return reviewClient; } }).reviewEvidence({ evidenceId: 'E-1', decision: 'VALID', operatorOrganizationId: ids.org, operatorUserId: ids.operator, actorKind: 'HUMAN', actorRef: ids.operator, correlationId: 'LOT-REVIEW-001' });
assert.equal(reviewed.preTradeEligible, true);
assert.equal(reviewed.lot.status, 'VERIFIED_ELIGIBLE');
assert.equal(reviewed.offer.state, 'VISIBLE');
assert.ok(reviewQueries.findIndex(({ sql }) => sql.includes('UPDATE lots SET state')) < reviewQueries.findIndex(({ sql }) => sql.includes('INSERT INTO offers')));
await assert.rejects(() => new PostgresDomainAdapter({ async connect() { return draftClient; } }).registerLotDraft({ lotId: 'LOT-BAD', supplierOrganizationId: ids.org, supplierUserId: ids.supplier, specId: 'GABA-SPEC-001', availableQty: 1000, askPrice: 21800, deliveryDays: 10, evidenceBundle: bundle.slice(0, 4), actorRef: ids.supplier, correlationId: 'LOT-BAD-001' }), (error) => error instanceof PostgresDomainAdapterError && error.code === 'PRETRADE_EVIDENCE_REQUIRED');
console.log('postgres lot review gate tests: PASS');
