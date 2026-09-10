import assert from 'node:assert/strict';
import { PostgresDomainAdapter } from './postgres-domain-adapter.mjs';

const calls = [];
const ids = {
  org: '00000000-0000-0000-0000-000000000011',
  user: '00000000-0000-0000-0000-000000000012',
  trade: '00000000-0000-0000-0000-000000000013',
  order: '00000000-0000-0000-0000-000000000014',
  reservation: '00000000-0000-0000-0000-000000000015',
};
const client = {
  async query(sql, params = []) {
    calls.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM trades t JOIN')) return { rows: [{ trade_id: ids.trade, order_id: ids.order, lot_id: 'LOT-ATOMIC', state: 'DELIVERED', price: '21800', quantity: '100', supplier_organization_id: ids.org, spec_id: 'GABA-SPEC-001', reservation_id: ids.reservation, reservation_state: 'ACTIVE' }] };
    if (sql.includes('UPDATE trades SET state')) return { rows: [{ trade_id: ids.trade, state: 'COMPLETED', completed_at: '2026-09-08' }] };
    if (sql.includes('INSERT INTO trade_inspections')) return { rows: [{ trade_id: ids.trade, reservation_id: ids.reservation, state: 'COMPLETED', spec_match: true, quality_pass: true }] };
    if (sql.includes('INSERT INTO price_observations')) throw new Error('simulated price observation failure');
    return { rows: [] };
  },
  release() {},
};
const adapter = new PostgresDomainAdapter({ async connect() { return client; } });
await assert.rejects(
  () => adapter.inspectTradeAndRecordPrice({ tradeId: ids.trade, operatorOrganizationId: ids.org, operatorUserId: ids.user, specMatch: true, qualityPass: true, actorKind: 'HUMAN', actorRef: ids.user, correlationId: 'ATOMIC-INSPECT-001' }),
  /simulated price observation failure/,
);
assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
assert.equal(calls.some(({ sql }) => sql === 'ROLLBACK'), true);
assert.ok(calls.findIndex(({ sql }) => sql.includes('INSERT INTO trade_inspections')) < calls.findIndex(({ sql }) => sql.includes('INSERT INTO price_observations')));
console.log('postgres atomic inspection-price tests: PASS');
