import assert from 'node:assert/strict';
import { calculatePriceIndex, loadPricePolicy } from './price-index.mjs';

const now = new Date('2026-09-08T00:00:00.000Z');
assert.equal(loadPricePolicy().status, 'SIMULATION_ONLY');

const empty = calculatePriceIndex({ specId: 'GABA-SPEC-001', observations: [], now });
assert.equal(empty.status, 'UNAVAILABLE');
assert.equal(empty.value, null);
assert.equal(empty.reason, 'INSUFFICIENT_COMPLETED_TRADES');

const observations = [
  { tradeId: 'T-001', specId: 'GABA-SPEC-001', supplierId: 'S-001', price: 21450, quantity: 100, quantityUnit: 'KG', priceUnit: 'KRW_PER_KG', currency: 'KRW', fulfilledAt: '2026-09-01', status: 'FULFILLED', evidenceStatus: 'VALID' },
  { tradeId: 'T-002', specId: 'GABA-SPEC-001', supplierId: 'S-002', price: 21800, quantity: 200, quantityUnit: 'KG', priceUnit: 'KRW_PER_KG', currency: 'KRW', fulfilledAt: '2026-09-02', status: 'FULFILLED', evidenceStatus: 'VALID' },
  { tradeId: 'T-003', specId: 'GABA-SPEC-001', supplierId: 'S-001', price: 22000, quantity: 100, quantityUnit: 'KG', priceUnit: 'KRW_PER_KG', currency: 'KRW', fulfilledAt: '2026-09-03', status: 'FULFILLED', evidenceStatus: 'VALID' },
  { tradeId: 'T-004', specId: 'GABA-SPEC-001', supplierId: 'S-003', price: 1000, quantity: 100, quantityUnit: 'KG', priceUnit: 'KRW_PER_KG', currency: 'KRW', fulfilledAt: '2026-08-01', status: 'FULFILLED', evidenceStatus: 'VALID' },
];

const index = calculatePriceIndex({ specId: 'GABA-SPEC-001', observations, now });
assert.equal(index.status, 'AVAILABLE');
assert.equal(index.value, 21763);
assert.equal(index.sampleSize, 3);
assert.equal(index.distinctSuppliers, 2);
assert.ok(index.confidence > 0);
assert.deepEqual(index.provenance, ['T-001', 'T-002', 'T-003']);
assert.deepEqual(index.priceSeries, [
  { fulfilledAt: '2026-09-01', price: 21450 },
  { fulfilledAt: '2026-09-02', price: 21800 },
  { fulfilledAt: '2026-09-03', price: 22000 },
]);
assert.ok(index.priceSeries.every((point) => !Object.prototype.hasOwnProperty.call(point, 'supplierId')));
assert.equal(index.currency, 'KRW');
assert.equal(index.priceUnit, 'KRW_PER_KG');
assert.equal(index.quantityUnit, 'KG');

const mixedUnitIndex = calculatePriceIndex({
  specId: 'GABA-SPEC-001',
  observations: observations.map((item, index) => index === 2 ? { ...item, quantityUnit: 'MT' } : item),
  now,
});
assert.equal(mixedUnitIndex.status, 'UNAVAILABLE');
assert.equal(mixedUnitIndex.sampleSize, 2);

const singleSupplier = calculatePriceIndex({
  specId: 'GABA-SPEC-001',
  observations: observations.map((item) => ({ ...item, supplierId: 'S-001' })),
  now,
});
assert.equal(singleSupplier.status, 'UNAVAILABLE');
assert.equal(singleSupplier.reason, 'INSUFFICIENT_DISTINCT_SUPPLIERS');

console.log('price-index tests: PASS');
