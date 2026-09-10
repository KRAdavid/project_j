import assert from 'node:assert/strict';
import { buildMarketBoard, isServerEligibleOffer } from './market-board.mjs';
import { INVENTORY_STATES } from './inventory-ledger.mjs';

const valid = {
  lotId: 'LOT-VALID', supplier: '검증공급자', specId: 'GABA-SPEC-001', availableQty: 120,
  askPrice: 21800, currency: 'KRW', priceUnit: 'KRW_PER_KG', quantityUnit: 'KG', deliveryDays: 10,
  status: INVENTORY_STATES.VERIFIED_ELIGIBLE,
  evidence: { coa: 'VALID', sds: 'VALID', tds: 'VALID', lotTrace: 'VALID', inventoryProof: 'VALID', expiresAt: '2027-01-01' },
};

assert.equal(isServerEligibleOffer(valid, { specId: 'GABA-SPEC-001', now: new Date('2026-09-10') }), true);
for (const [key, value] of Object.entries({
  status: INVENTORY_STATES.PENDING_VERIFICATION,
  availableQty: 0,
  priceUnit: 'USD_PER_KG',
  evidence: { ...valid.evidence, coa: 'PENDING' },
  expired: true,
})) {
  const candidate = { ...valid, ...(key === 'expired' ? {} : { [key]: value }) };
  if (key === 'expired') candidate.evidence = { ...valid.evidence, expiresAt: '2026-01-01' };
  assert.equal(isServerEligibleOffer(candidate, { specId: 'GABA-SPEC-001', now: new Date('2026-09-10') }), false, `must reject ${key}`);
}

const completedTrade = {
  tradeId: 'TRADE-DONE', specId: 'GABA-SPEC-001', status: 'FULFILLED', price: 21700, quantity: 40,
  currency: 'KRW', priceUnit: 'KRW_PER_KG', quantityUnit: 'KG', fulfilledAt: '2026-09-09',
  evidenceSnapshot: { coa: 'VALID', sds: 'VALID', tds: 'VALID', lotTrace: 'VALID', inventoryProof: 'VALID' },
};
const board = buildMarketBoard({ lots: [valid, { ...valid, lotId: 'LOT-CHEAP', askPrice: 21500 }, { ...valid, lotId: 'LOT-OTHER', specId: 'OTHER' }], trades: [completedTrade, { ...completedTrade, tradeId: 'TRADE-DISPUTED', status: 'DISPUTED' }] }, { specId: 'GABA-SPEC-001', now: new Date('2026-09-10'), generatedAt: '2026-09-10T00:00:00.000Z' });
assert.deepEqual(board.asks.map((offer) => offer.lotId), ['LOT-CHEAP', 'LOT-VALID']);
assert.equal(board.bestAsk, 21500);
assert.equal(board.verifiedInventoryQty, 240);
assert.deepEqual(board.bids, []);
assert.deepEqual(board.recentTrades.map((trade) => trade.tradeId), ['TRADE-DONE']);
assert.equal(board.activityStatus, 'SERVER_VERIFIED_COMPLETED_TRADES');
assert.equal(board.asks[0].evidenceStatus, 'PRETRADE_VERIFIED');
assert.equal('supplierOrganizationId' in board.asks[0], false);
console.log('market board contract tests: PASS');
