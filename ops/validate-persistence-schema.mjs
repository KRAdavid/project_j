import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sql = await readFile(resolve(root, 'data/postgres-schema.sql'), 'utf8');
for (const table of ['organizations', 'supplier_verification_requests', 'supplier_prechecks', 'materials', 'specifications', 'lots', 'evidences', 'offers', 'purchase_orders', 'reservations', 'trades', 'trade_inspections', 'trade_events', 'operational_approvals', 'approval_events', 'price_observations']) {
  assert.match(sql, new RegExp(`create table(?: if not exists)? ${table}\\s*\\(`, 'i'), `테이블 누락: ${table}`);
}
for (const token of ['idempotency_key', 'counter_offer', 'spec_attributes', 'spec_snapshot', 'lot_snapshot', 'evidence_snapshot', 'pretrade_checks', 'trade_snapshot_hash', 'price_unit', 'quantity_unit', 'reserve_lot', 'PHYSICAL_MATERIAL', 'Append-only audit ledger', 'approval_state', 'H-01 operational decisions']) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(sql, new RegExp(escaped, 'i'), `필수 구성 누락: ${token}`);
}
assert.match(sql, /primary key \(organization_id, user_id, role\)/i, '조직 멤버십은 동일 계정의 구매자·공급자 복수 역할을 지원해야 합니다.');
assert.match(sql, /old primary key.*organization_id, user_id/i, '기존 단일 역할 멤버십에서의 안전한 업그레이드 경계가 필요합니다.');
assert.doesNotMatch(sql, /create table\s+(derivatives|securities|margin)/i, '실물 원료 범위를 벗어난 테이블이 들어가면 안 됩니다.');
console.log('persistence schema tests: PASS');
