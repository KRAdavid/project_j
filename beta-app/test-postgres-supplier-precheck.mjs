import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = {
  organization: '00000000-0000-0000-0000-000000000031',
  user: '00000000-0000-0000-0000-000000000032',
};
const review = { status: 'REVIEWED', mode: 'PRODUCTION_RULE_PRECHECK', ready: true, checks: { priceTierPresent: true }, reasons: [], guardrail: 'AI는 승인하지 않습니다.' };
const row = {
  precheck_id: '00000000-0000-0000-0000-000000000033',
  organization_id: ids.organization,
  submitted_by: ids.user,
  idempotency_key: 'SUPPLIER-PRECHECK-001',
  input_fingerprint: 'a'.repeat(64),
  material: 'GABA',
  coa_document_number: 'COA-GABA-001',
  coa_file_name: 'coa.pdf',
  coa_file_size: 2048,
  inventory_quantity: '100',
  unit: 'KG',
  expiry_date: '2099-12-31',
  price_tiers: [{ quantity: 20, price: 21800 }],
  review,
  created_at: '2026-09-14T00:00:00.000Z',
};
let inserted = false;
const queries = [];
const client = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('INSERT INTO supplier_prechecks')) {
      if (inserted) return { rows: [] };
      inserted = true;
      return { rows: [row] };
    }
    if (sql.includes('SELECT * FROM supplier_prechecks')) return { rows: [row] };
    if (sql.includes('INSERT INTO trade_events')) return { rows: [] };
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });
const input = {
  supplierOrganizationId: ids.organization,
  supplierUserId: ids.user,
  idempotencyKey: row.idempotency_key,
  inputFingerprint: row.input_fingerprint,
  material: row.material,
  coaDocumentNumber: row.coa_document_number,
  coaFileName: row.coa_file_name,
  coaFileSize: row.coa_file_size,
  inventoryQuantity: row.inventory_quantity,
  unit: row.unit,
  expiry: row.expiry_date,
  priceTiers: row.price_tiers,
  review,
  actorKind: 'SYSTEM',
  actorRef: 'AI-SUPPLIER-PRECHECK',
  correlationId: 'CORR-SUPPLIER-PRECHECK-001',
};

const first = await adapter.supplierPrecheck(input);
assert.equal(first.idempotent, false);
assert.equal(first.status, 'PRECHECK_REVIEWED');
assert.equal(first.precheck.precheckId, row.precheck_id);
assert.equal(first.review.ready, true);

const retry = await adapter.supplierPrecheck(input);
assert.equal(retry.idempotent, true);
assert.equal(retry.precheck.precheckId, row.precheck_id);

await assert.rejects(
  () => adapter.supplierPrecheck({ ...input, inputFingerprint: 'b'.repeat(64) }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
);
assert.ok(queries.some(({ sql }) => sql === 'COMMIT'));
assert.ok(queries.some(({ sql }) => sql === 'ROLLBACK'));
console.log('postgres supplier precheck tests: PASS');
