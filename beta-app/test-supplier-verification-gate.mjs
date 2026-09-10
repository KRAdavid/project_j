import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = { org: '00000000-0000-0000-0000-000000000071', supplier: '00000000-0000-0000-0000-000000000072' };
const bundle = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'].map((evidenceType) => ({ evidenceType, documentVersion: '1', contentSha256: 'b'.repeat(64), storageRef: `s3://evidence/${evidenceType}` }));
const client = {
  async query(sql) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM organizations WHERE organization_id')) return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    return { rows: [] };
  },
  release() {},
};
await assert.rejects(() => new PostgresDomainAdapter({ async connect() { return client; } }).registerLotDraft({ lotId: 'LOT-UNVERIFIED', supplierOrganizationId: ids.org, supplierUserId: ids.supplier, specId: 'GABA-SPEC-001', availableQty: 100, askPrice: 21800, deliveryDays: 10, evidenceBundle: bundle, actorKind: 'HUMAN', actorRef: ids.supplier, correlationId: 'SUPPLIER-GATE-001' }), (error) => error instanceof PostgresDomainAdapterError && error.code === 'SUPPLIER_ORGANIZATION_NOT_VERIFIED');
console.log('supplier verification gate tests: PASS');
