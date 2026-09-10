import assert from 'node:assert/strict';
import { PriceFeed, PriceFeedError } from './price-feed.mjs';

const feed = new PriceFeed({ publicationApproved: true, approvalRef: 'H-01-PRICE-001' });
assert.throws(() => feed.ingest({ sourceType: 'SUPPLIER_QUOTE', observations: [{ quoteId: 'Q-1' }] }), (error) => error instanceof PriceFeedError && error.code === 'PRICE_OBSERVATION_INVALID');
const base = { specId: 'GABA-SPEC-001', supplierId: 'S-1', quantity: 100, quantityUnit: 'KG', priceUnit: 'KRW_PER_KG', currency: 'KRW', status: 'FULFILLED', evidenceStatus: 'VALID' };
const accepted = feed.ingest({ sourceType: 'COMPLETED_PHYSICAL_TRADE', observations: [
  { ...base, tradeId: 'T-1', price: 21000, fulfilledAt: '2026-09-01' },
  { ...base, tradeId: 'T-2', supplierId: 'S-2', price: 21500, fulfilledAt: '2026-09-02' },
  { ...base, tradeId: 'T-3', supplierId: 'S-1', price: 22200, fulfilledAt: '2026-09-03' },
] });
assert.equal(accepted.accepted, 3);
assert.throws(() => feed.ingest({ sourceType: 'COMPLETED_PHYSICAL_TRADE', observations: [{ ...base, tradeId: 'T-MT', quantityUnit: 'MT', price: 21000, fulfilledAt: '2026-09-04' }] }), (error) => error instanceof PriceFeedError && error.code === 'PRICE_OBSERVATION_UNIT_MISMATCH');
assert.equal(feed.ingest({ sourceType: 'COMPLETED_PHYSICAL_TRADE', observations: [{ ...base, tradeId: 'T-1', price: 99999, fulfilledAt: '2026-09-01' }] }).duplicateIgnored, 1);
const result = feed.calculate('GABA-SPEC-001', new Date('2026-09-08'));
assert.equal(result.status, 'AVAILABLE');
assert.equal(result.aiTrend.direction, 'UPWARD');
assert.equal(feed.status().rawSupplierIdentityPublic, false);
assert.equal(feed.status().approvalRef, 'H-01-PRICE-001');
const restoredFeed = new PriceFeed({ publicationApproved: true, approvalRef: 'H-01-PRICE-001' });
restoredFeed.restore(feed.snapshot());
assert.equal(restoredFeed.status().observationCount, 3);
assert.equal(restoredFeed.calculate('GABA-SPEC-001', new Date('2026-09-08')).aiTrend.direction, 'UPWARD');
assert.throws(() => new PriceFeed().restore([{ ...base, sourceType: 'COMPLETED_PHYSICAL_TRADE', tradeId: 'RESTORE-MT', price: 21000, fulfilledAt: '2026-09-04', quantityUnit: 'MT' }]), (error) => error instanceof PriceFeedError && error.code === 'PRICE_OBSERVATION_UNIT_MISMATCH');

const unpublishedFeed = new PriceFeed();
unpublishedFeed.ingest({ sourceType: 'COMPLETED_PHYSICAL_TRADE', observations: [
  { ...base, tradeId: 'U-1', price: 21000, fulfilledAt: '2026-09-01' },
  { ...base, tradeId: 'U-2', supplierId: 'S-2', price: 21500, fulfilledAt: '2026-09-02' },
  { ...base, tradeId: 'U-3', supplierId: 'S-1', price: 22200, fulfilledAt: '2026-09-03' },
] });
assert.equal(unpublishedFeed.calculate('GABA-SPEC-001', new Date('2026-09-08')).status, 'PENDING_HUMAN_APPROVAL');
console.log('price-feed tests: PASS');
