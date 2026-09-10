import assert from 'node:assert/strict';
import { reconcileDomainState } from './domain-reconciliation.mjs';

const bridge = {
  dataStatus: 'SIMULATED_BACKEND',
  lots: [{ lotId: 'LOT-1', specId: 'GABA-SPEC-001', status: 'VERIFIED_ELIGIBLE', availableQty: 100, reservedQty: 0 }],
  orders: [{ orderId: 'ORDER-1', specId: 'GABA-SPEC-001', status: 'ACCEPTED', price: 12000, quantity: 20, deliveryDate: '2026-10-01' }],
  trades: [{ tradeId: 'TRADE-1', orderId: 'ORDER-1', lotId: 'LOT-1', specId: 'GABA-SPEC-001', status: 'CONFIRMED', price: 12000, quantity: 20, deliveryDate: '2026-10-01', tradeSnapshotHash: 'a'.repeat(64) }],
};
const matched = reconcileDomainState({ bridgeSnapshot: bridge, domainSnapshot: { ...bridge, dataStatus: 'LIVE_POSTGRESQL_LEDGER' } });
assert.equal(matched.status, 'MATCH');
assert.equal(matched.safe, true);
const mismatch = reconcileDomainState({ bridgeSnapshot: bridge, domainSnapshot: { ...bridge, lots: [{ ...bridge.lots[0], availableQty: 80 }] } });
assert.equal(mismatch.status, 'MISMATCH');
assert.equal(mismatch.safe, false);
assert.ok(mismatch.issues.some((issue) => issue.code === 'FIELD_MISMATCH'));
const missing = reconcileDomainState({ domainSnapshot: bridge });
assert.equal(missing.status, 'NO_REFERENCE');
console.log('domain reconciliation tests: PASS');
