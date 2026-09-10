import assert from 'node:assert/strict';
import { hashSnapshot, sealTradeSnapshot, tradeIntegrityPayload, verifyTradeSnapshot } from './snapshot-integrity.mjs';

const trade = { tradeId: 'T-1', orderId: 'O-1', buyerId: 'B-1', supplierId: 'S-1', supplierOrganizationId: 'ORG-1', materialId: 'GABA', specId: 'GABA-SPEC-001', specSnapshot: {}, lotSnapshot: { lotId: 'LOT-1' }, evidenceSnapshot: { coa: 'VALID' }, price: 21800, quantity: 20, deliveryDate: '2026-09-15', preTradeChecks: { evidenceValid: true }, reservationId: 'R-1', confirmedAt: '2026-09-08T00:00:00.000Z' };
const sealed = sealTradeSnapshot(trade);
assert.equal(sealed.tradeSnapshotHash, hashSnapshot(tradeIntegrityPayload(trade)));
assert.equal(verifyTradeSnapshot(sealed), true);
assert.equal(verifyTradeSnapshot({ ...sealed, quantity: 21 }), false);
console.log('snapshot integrity tests: PASS');
