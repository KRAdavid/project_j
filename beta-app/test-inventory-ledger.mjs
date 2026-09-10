import assert from 'node:assert/strict';
import { EvidenceLockedInventory, INVENTORY_STATES, InventoryRuleError } from './inventory-ledger.mjs';

const now = new Date('2026-09-08T00:00:00.000Z');
const ledger = new EvidenceLockedInventory({ now: () => new Date(now) });
for (const invalidLot of [
  { lotId: 'LOT-NEGATIVE-PRICE', askPrice: -1, availableQty: 1, reservedQty: 0, deliveryDays: 1 },
  { lotId: 'LOT-ZERO-PRICE', askPrice: 0, availableQty: 1, reservedQty: 0, deliveryDays: 1 },
  { lotId: 'LOT-NEGATIVE-RESERVED', askPrice: 1, availableQty: 1, reservedQty: -1, deliveryDays: 1 },
  { lotId: 'LOT-NEGATIVE-DELIVERY', askPrice: 1, availableQty: 1, reservedQty: 0, deliveryDays: -1 },
  { lotId: 'LOT-NAN-DELIVERY', askPrice: 1, availableQty: 1, reservedQty: 0, deliveryDays: Number.NaN },
]) {
  assert.throws(() => ledger.registerLot(invalidLot), (error) => {
    assert.ok(error instanceof InventoryRuleError);
    assert.equal(error.code, 'INVALID_LOT');
    return true;
  }, `잘못된 로트 입력 ${invalidLot.lotId}는 등록되면 안 됩니다.`);
}
ledger.registerLot({
  lotId: 'LOT-001',
  supplier: '한빛바이오',
  specId: 'GABA-SPEC-001',
  askPrice: 21800,
  availableQty: 1200,
  status: INVENTORY_STATES.VERIFIED_ELIGIBLE,
  evidence: { coa: 'VALID', sds: 'VALID', tds: 'VALID', lotTrace: 'VALID', inventoryProof: 'VALID', expiresAt: '2027-07-31' },
  deliveryDays: 10,
});

const candidate = ledger.findEligible({ specId: 'GABA-SPEC-001', price: 21800, quantity: 1000, deliveryDays: 14 });
assert.equal(candidate.lotId, 'LOT-001');

const expiredLedger = new EvidenceLockedInventory({ now: () => new Date(now) });
expiredLedger.registerLot({
  lotId: 'LOT-EXPIRED',
  supplier: '만료공급자',
  specId: 'GABA-SPEC-001',
  askPrice: 21000,
  availableQty: 1000,
  status: INVENTORY_STATES.VERIFIED_ELIGIBLE,
  evidence: { coa: 'VALID', sds: 'VALID', specification: 'VALID', expiresAt: '2026-09-07' },
  deliveryDays: 10,
});
assert.equal(expiredLedger.findEligible({ specId: 'GABA-SPEC-001', price: 22000, quantity: 20, deliveryDays: 14 }), null, '만료 증빙 로트는 노출되면 안 됩니다.');

const reserved = ledger.reserve('LOT-001', 1000, 'ORDER-001', { specId: 'GABA-SPEC-001', deliveryDays: 14 });
assert.equal(reserved.lot.availableQty, 200);
assert.equal(reserved.lot.reservedQty, 1000);

const duplicateReservation = ledger.reserve('LOT-001', 1000, 'ORDER-001', { specId: 'GABA-SPEC-001', deliveryDays: 14 });
assert.deepEqual(duplicateReservation, reserved, '같은 예약 ID는 재고를 다시 차감하지 않아야 합니다.');

assert.throws(() => ledger.reserve('LOT-001', 900, 'ORDER-001', { specId: 'GABA-SPEC-001', deliveryDays: 14 }), (error) => {
  assert.ok(error instanceof InventoryRuleError);
  assert.equal(error.code, 'RESERVATION_ID_REUSE_MISMATCH');
  return true;
}, '같은 예약 ID의 다른 수량 요청은 조용히 재사용되면 안 됩니다.');

assert.throws(() => ledger.reserve('LOT-001', 1000, 'ORDER-001', { specId: 'GABA-SPEC-001', deliveryDays: 10 }), (error) => {
  assert.ok(error instanceof InventoryRuleError);
  assert.equal(error.code, 'RESERVATION_ID_REUSE_MISMATCH');
  return true;
}, '같은 예약 ID의 다른 납기 조건도 재사용되면 안 됩니다.');

assert.throws(() => ledger.reserve('LOT-001', 300, 'ORDER-002', { specId: 'GABA-SPEC-001', deliveryDays: 14 }), (error) => {
  assert.ok(error instanceof InventoryRuleError);
  assert.equal(error.code, 'INVENTORYAVAILABLE');
  return true;
});

for (const invalidQuantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => ledger.reserve('LOT-001', invalidQuantity, `INVALID-${String(invalidQuantity)}`, { specId: 'GABA-SPEC-001', deliveryDays: 14 }), (error) => {
    assert.ok(error instanceof InventoryRuleError);
    assert.equal(error.code, 'INVALID_RESERVATION_QUANTITY');
    return true;
  }, `잘못된 예약 수량 ${String(invalidQuantity)}는 차단되어야 합니다.`);
}
assert.equal(ledger.snapshot().lots[0].availableQty, 200, '잘못된 예약 입력은 재고를 변경하면 안 됩니다.');

ledger.markDelivered('ORDER-001');
const dispute = ledger.inspect('ORDER-001', { specMatch: false, qualityPass: false, note: '납품 로트 시험 결과 불일치' });
assert.equal(dispute.reservation.status, 'DISPUTED');
assert.equal(dispute.lot.status, INVENTORY_STATES.QUARANTINED);

console.log('inventory-ledger tests: PASS');
