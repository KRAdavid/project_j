import { INVENTORY_STATES } from './inventory-ledger.mjs';

const REQUIRED_EVIDENCE = ['coa', 'sds', 'tds', 'lotTrace', 'inventoryProof'];
const CANONICAL_TERMS = Object.freeze({ currency: 'KRW', priceUnit: 'KRW_PER_KG', quantityUnit: 'KG' });

const clone = (value) => JSON.parse(JSON.stringify(value));

const isDateValidAndCurrent = (value, now) => {
  const expiry = value ? new Date(value) : null;
  return expiry instanceof Date && Number.isFinite(expiry.valueOf()) && expiry >= now;
};

export const isServerEligibleOffer = (lot, { specId, now = new Date() } = {}) => {
  if (!lot || String(lot.specId) !== String(specId)) return false;
  if (lot.status !== INVENTORY_STATES.VERIFIED_ELIGIBLE) return false;
  if (!Number.isFinite(Number(lot.availableQty)) || Number(lot.availableQty) <= 0) return false;
  if (!Number.isFinite(Number(lot.askPrice)) || Number(lot.askPrice) <= 0) return false;
  if (!REQUIRED_EVIDENCE.every((key) => lot.evidence?.[key] === 'VALID')) return false;
  if (!isDateValidAndCurrent(lot.evidence?.expiresAt, now)) return false;
  return CANONICAL_TERMS.currency === lot.currency
    && CANONICAL_TERMS.priceUnit === lot.priceUnit
    && CANONICAL_TERMS.quantityUnit === lot.quantityUnit;
};

const publicOffer = (lot) => ({
  lotId: lot.lotId,
  supplier: lot.supplier,
  specId: lot.specId,
  availableQty: Number(lot.availableQty),
  askPrice: Number(lot.askPrice),
  currency: lot.currency,
  priceUnit: lot.priceUnit,
  quantityUnit: lot.quantityUnit,
  deliveryDays: Number(lot.deliveryDays),
  evidenceStatus: 'PRETRADE_VERIFIED',
  evidenceExpiresAt: lot.evidence.expiresAt,
  matchStatus: 'EXACT_SPEC',
});

const evidenceRecordIsValid = (record) => record === 'VALID' || record?.state === 'VALID' || record?.status === 'VALID';
const completedTradeIsPublic = (trade, specId) => {
  const tradeSpecId = trade?.specId || trade?.specSnapshot?.specId;
  const completed = ['FULFILLED', 'COMPLETED'].includes(String(trade?.status || trade?.state));
  const fulfilledAt = trade?.fulfilledAt || trade?.completedAt;
  const timestampValid = fulfilledAt && Number.isFinite(new Date(fulfilledAt).valueOf());
  const evidence = trade?.evidenceSnapshot || {};
  const evidenceValid = REQUIRED_EVIDENCE.every((key) => evidenceRecordIsValid(evidence[key] ?? evidence[key.toUpperCase()]));
  return completed && String(tradeSpecId) === String(specId) && timestampValid && evidenceValid
    && CANONICAL_TERMS.currency === (trade.currency || CANONICAL_TERMS.currency)
    && CANONICAL_TERMS.priceUnit === (trade.priceUnit || CANONICAL_TERMS.priceUnit)
    && CANONICAL_TERMS.quantityUnit === (trade.quantityUnit || CANONICAL_TERMS.quantityUnit)
    && Number.isFinite(Number(trade.price)) && Number(trade.price) > 0
    && Number.isFinite(Number(trade.quantity)) && Number(trade.quantity) > 0;
};

const publicCompletedTrade = (trade) => ({
  tradeId: trade.tradeId,
  price: Number(trade.price),
  quantity: Number(trade.quantity),
  currency: trade.currency || CANONICAL_TERMS.currency,
  priceUnit: trade.priceUnit || CANONICAL_TERMS.priceUnit,
  quantityUnit: trade.quantityUnit || CANONICAL_TERMS.quantityUnit,
  fulfilledAt: trade.fulfilledAt || trade.completedAt,
  disclosureStatus: 'COMPLETED_PHYSICAL_TRADE',
});

export const buildMarketBoard = (snapshot, { specId, now = new Date(), generatedAt = new Date().toISOString() } = {}) => {
  const lots = Array.isArray(snapshot?.lots) ? snapshot.lots : [];
  const asks = lots
    .filter((lot) => isServerEligibleOffer(lot, { specId, now }))
    .map(publicOffer)
    .sort((a, b) => a.askPrice - b.askPrice || a.deliveryDays - b.deliveryDays || a.lotId.localeCompare(b.lotId));
  const verifiedInventoryQty = asks.reduce((total, offer) => total + offer.availableQty, 0);
  const recentTrades = (Array.isArray(snapshot?.trades) ? snapshot.trades : [])
    .filter((trade) => completedTradeIsPublic(trade, specId))
    .map(publicCompletedTrade)
    .sort((a, b) => new Date(b.fulfilledAt) - new Date(a.fulfilledAt))
    .slice(0, 20);
  return clone({
    schemaVersion: 'SERVER-VERIFIED-MARKET-BOARD-0.1',
    specId,
    dataStatus: asks.length ? 'SERVER_VERIFIED_OFFERS' : 'NO_VERIFIED_OFFERS',
    generatedAt,
    asks,
    bids: [],
    bidDisclosure: 'PUBLIC_BID_BOOK_DISABLED_UNTIL_DISCLOSURE_POLICY_APPROVED',
    recentTrades,
    activityStatus: recentTrades.length ? 'SERVER_VERIFIED_COMPLETED_TRADES' : 'NO_COMPLETED_TRADES',
    verifiedInventoryQty,
    bestAsk: asks[0]?.askPrice || null,
    guardrail: '검증 상태·유효 증빙·가용 재고·표준 거래단위를 모두 통과한 서버 원장 매물만 노출합니다.',
  });
};
