import assert from 'node:assert/strict';
import { projectEvidence, projectSnapshot } from './authorization.mjs';

const snapshot = {
  lots: [{ lotId: 'LOT-A', supplierId: 'SUP-A', supplier: '공급자A', evidence: { coa: 'VALID' } }, { lotId: 'LOT-B', supplierId: 'SUP-B', supplier: '공급자B', evidence: { coa: 'VALID' } }],
  orders: [{ orderId: 'ORDER-A', buyerId: 'BUY-A', buyerOrganizationId: 'ORG-A', candidateLotId: 'LOT-A' }, { orderId: 'ORDER-B', buyerId: 'BUY-B', buyerOrganizationId: 'ORG-B', candidateLotId: 'LOT-B' }, { orderId: 'ORDER-OPEN', buyerId: 'BUY-C', buyerOrganizationId: 'ORG-C', specId: 'GABA-SPEC-001', status: 'SUBMITTED' }],
  trades: [{ tradeId: 'TRADE-A', orderId: 'ORDER-A', supplierId: 'SUP-A', lotSnapshot: { lotId: 'LOT-A' } }, { tradeId: 'TRADE-B', orderId: 'ORDER-B', supplierId: 'SUP-B', lotSnapshot: { lotId: 'LOT-B' } }],
  events: [{ details: { orderId: 'ORDER-A' } }, { details: { orderId: 'ORDER-B' } }],
};
const buyer = projectSnapshot(snapshot, { role: 'BUYER', userId: 'BUY-A', organizationId: 'ORG-A' });
assert.deepEqual(buyer.orders.map((item) => item.orderId), ['ORDER-A']);
assert.deepEqual(buyer.trades.map((item) => item.tradeId), ['TRADE-A']);
assert.equal(buyer.lots[0].supplierId, undefined);
assert.equal(buyer.lots[0].evidence, undefined);
const supplier = projectSnapshot(snapshot, { role: 'SUPPLIER', userId: 'SUP-A', organizationId: 'SUP-ORG-A' });
assert.deepEqual(supplier.orders.map((item) => item.orderId), ['ORDER-A', 'ORDER-OPEN']);
assert.equal(supplier.orders.some((item) => item.orderId === 'ORDER-OPEN'), true);
assert.equal(supplier.orders.find((item) => item.orderId === 'ORDER-OPEN').buyerOrganizationId, undefined);
assert.deepEqual(supplier.trades.map((item) => item.tradeId), ['TRADE-A']);
const expiredSnapshot = {
  ...snapshot,
  lots: [...snapshot.lots, { lotId: 'LOT-EXPIRED', supplierId: 'SUP-X', status: 'VERIFIED_ELIGIBLE', availableQty: 100, evidence: { expiresAt: '2020-01-01' } }],
};
const expiredBuyer = projectSnapshot(expiredSnapshot, { role: 'BUYER', userId: 'BUY-A', organizationId: 'ORG-A' });
assert.equal(expiredBuyer.lots.some((lot) => lot.lotId === 'LOT-EXPIRED'), false);
const operator = projectSnapshot(snapshot, { role: 'OPERATOR', userId: 'OP-1', organizationId: 'OP-ORG' });
assert.equal(operator.orders.length, 3);
const postgresLike = projectSnapshot({ ...snapshot, evidence: [{ evidenceId: 'E-1', lotId: 'LOT-A', storageRef: 'private://coa', contentSha256: 'secret', organizationId: 'ORG-A' }], inventory: { lots: snapshot.lots, reservations: [{ reservationId: 'RES-A', lotId: 'LOT-A', orderId: 'ORDER-A' }], inspections: [] } }, { role: 'BUYER', userId: 'BUY-A', organizationId: 'ORG-A' });
assert.equal(postgresLike.evidence, undefined);
assert.equal(postgresLike.inventory.lots[0].evidence, undefined);
assert.equal(projectEvidence([{ evidenceId: 'E-1', organizationId: 'ORG-A', storageRef: 'private://coa', contentSha256: 'secret', state: 'VALID' }], { role: 'BUYER', userId: 'BUY-A', organizationId: 'ORG-A' })[0].storageRef, undefined);
console.log('snapshot projection tests: PASS');
