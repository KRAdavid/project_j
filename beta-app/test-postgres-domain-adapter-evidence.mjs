import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = { org: '00000000-0000-0000-0000-000000000031', supplier: '00000000-0000-0000-0000-000000000032', operator: '00000000-0000-0000-0000-000000000033', evidence: '00000000-0000-0000-0000-000000000034' };
const queries = [];
const client = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM lots WHERE')) return { rows: [{ lot_id: 'LOT-001', supplier_organization_id: ids.org }] };
    if (sql.includes('INSERT INTO evidences')) return { rows: [{ evidence_id: ids.evidence, lot_id: 'LOT-001', evidence_type: 'COA', document_version: '1.0', content_sha256: 'e'.repeat(64), storage_ref: 's3://evidence/coa', state: 'PENDING', organization_id: ids.org, submitted_by: ids.supplier }] };
    if (sql.includes('SELECT * FROM evidences')) return { rows: [{ evidence_id: ids.evidence, lot_id: 'LOT-001', evidence_type: 'COA', document_version: '1.0', content_sha256: 'e'.repeat(64), storage_ref: 's3://evidence/coa', state: 'PENDING', organization_id: ids.org, submitted_by: ids.supplier }] };
    if (sql.includes('UPDATE evidences SET')) return { rows: [{ evidence_id: ids.evidence, lot_id: 'LOT-001', evidence_type: 'COA', document_version: '1.0', content_sha256: 'e'.repeat(64), storage_ref: 's3://evidence/coa', state: 'VALID', organization_id: ids.org, submitted_by: ids.supplier, reviewed_by: ids.operator }] };
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });
const submitted = await adapter.submitEvidence({ lotId: 'LOT-001', evidenceType: 'COA', documentVersion: '1.0', contentSha256: 'e'.repeat(64), storageRef: 's3://evidence/coa', supplierOrganizationId: ids.org, supplierUserId: ids.supplier, actorKind: 'HUMAN', actorRef: ids.supplier, correlationId: 'CORR-EVIDENCE-001' });
assert.equal(submitted.evidence.state, 'PENDING');
const reviewed = await adapter.reviewEvidence({ evidenceId: ids.evidence, decision: 'VALID', operatorOrganizationId: ids.org, operatorUserId: ids.operator, actorKind: 'HUMAN', actorRef: ids.operator, correlationId: 'CORR-EVIDENCE-002' });
assert.equal(reviewed.evidence.state, 'VALID');
assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
await assert.rejects(() => adapter.submitEvidence({ lotId: 'LOT-001', evidenceType: 'COA', documentVersion: '1.0', contentSha256: 'bad', storageRef: 's3://evidence/coa', supplierOrganizationId: ids.org, supplierUserId: ids.supplier, actorRef: ids.supplier, correlationId: 'CORR-EVIDENCE-003' }), (error) => error instanceof PostgresDomainAdapterError && error.code === 'EVIDENCE_HASH_INVALID');
console.log('postgres domain adapter evidence tests: PASS');
