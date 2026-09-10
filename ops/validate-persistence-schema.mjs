import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sql = await readFile(resolve(root, 'data/postgres-schema.sql'), 'utf8');
for (const table of ['organizations', 'supplier_verification_requests', 'materials', 'specifications', 'lots', 'evidences', 'offers', 'purchase_orders', 'reservations', 'trades', 'trade_inspections', 'trade_events', 'operational_approvals', 'approval_events', 'price_observations']) {
  assert.match(sql, new RegExp(`create table(?: if not exists)? ${table}\\s*\\(`, 'i'), `테이블 누락: ${table}`);
}
for (const token of ['idempotency_key', 'counter_offer', 'spec_attributes', 'spec_snapshot', 'lot_snapshot', 'evidence_snapshot', 'pretrade_checks', 'trade_snapshot_hash', 'price_unit', 'quantity_unit', 'reserve_lot', 'PHYSICAL_MATERIAL', 'Append-only audit ledger', 'approval_state', 'H-01 operational decisions']) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(sql, new RegExp(escaped, 'i'), `필수 구성 누락: ${token}`);
}
assert.doesNotMatch(sql, /create table\s+(derivatives|securities|margin)/i, '실물 원료 범위를 벗어난 테이블이 들어가면 안 됩니다.');
console.log('persistence schema tests: PASS');

