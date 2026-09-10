import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = { organization: '00000000-0000-0000-0000-000000000021', user: '00000000-0000-0000-0000-000000000022' };
const types = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'];
const evidenceBundle = types.map((evidenceType) => ({ evidenceType, state: 'VALID', documentVersion: '1.0', contentSha256: 'd'.repeat(64), storageRef: `s3://raw-material/test/${evidenceType}`, expiresAt: '2027-01-01' }));
const queries = [];
const client = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [{ organization_id: ids.organization, verified_at: '2026-01-01', verification_evidence: { source: 'test' } }] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes("FROM specifications WHERE")) return { rows: [{ spec_id: 'GABA-SPEC-001' }] };
    if (sql.includes('INSERT INTO lots')) return { rows: [{ lot_id: 'LOT-001', supplier_organization_id: ids.organization, spec_id: 'GABA-SPEC-001', state: 'PENDING_VERIFICATION', total_quantity: '1000', available_quantity: '1000', reserved_quantity: '0', ask_price: '21800', delivery_days: 10 }] };
    if (sql.includes('SELECT min(expires_at)')) return { rows: [{ expires_at: '2027-01-01' }] };
    if (sql.includes('UPDATE lots SET state')) return { rows: [{ lot_id: 'LOT-001', supplier_organization_id: ids.organization, spec_id: 'GABA-SPEC-001', state: 'VERIFIED_ELIGIBLE', total_quantity: '1000', available_quantity: '1000', reserved_quantity: '0', ask_price: '21800', delivery_days: 10 }] };
    if (sql.includes('INSERT INTO offers')) return { rows: [{ offer_id: 'OFFER-001', lot_id: 'LOT-001', state: 'VISIBLE' }] };
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });
const result = await adapter.registerVerifiedLot({ lotId: 'LOT-001', supplierOrganizationId: ids.organization, supplierUserId: ids.user, supplier: '테스트 공급자', specId: 'GABA-SPEC-001', availableQty: 1000, askPrice: 21800, deliveryDays: 10, evidenceBundle, actorKind: 'HUMAN', actorRef: ids.user, correlationId: 'CORR-LOT-001' });
assert.equal(result.lot.status, 'VERIFIED_ELIGIBLE');
assert.equal(result.offer.state, 'VISIBLE');
assert.equal(result.evidence.length, 5);
assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO lots')));
assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO offers')));
assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
await assert.rejects(() => adapter.registerVerifiedLot({ lotId: 'LOT-002', supplierOrganizationId: ids.organization, supplierUserId: ids.user, specId: 'GABA-SPEC-001', availableQty: 1000, askPrice: 21800, deliveryDays: 10, evidenceBundle: evidenceBundle.slice(0, 4), actorRef: ids.user, correlationId: 'CORR-LOT-002' }), (error) => error instanceof PostgresDomainAdapterError && error.code === 'PRETRADE_EVIDENCE_REQUIRED');
console.log('postgres domain adapter lot tests: PASS');
