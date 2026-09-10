import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const policyPath = resolve(fileURLToPath(new URL('../data/price-index-policy.json', import.meta.url)));
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
const sourceContractPath = resolve(fileURLToPath(new URL('../data/price-source-contract.json', import.meta.url)));
const sourceContract = JSON.parse(readFileSync(sourceContractPath, 'utf8'));

const clone = (value) => JSON.parse(JSON.stringify(value));

export const loadPricePolicy = () => clone(policy);

const validObservation = (observation, specId, cutoff) => {
  const fulfilledAt = new Date(observation.fulfilledAt || '');
  return observation.specId === specId
    && observation.status === policy.requiredTradeStatus
    && observation.evidenceStatus === policy.requiredEvidenceStatus
    && observation.currency === policy.canonicalCurrency
    && observation.priceUnit === policy.canonicalPriceUnit
    && observation.quantityUnit === policy.canonicalQuantityUnit
    && Boolean(observation.tradeId)
    && Boolean(observation.supplierId)
    && Number.isFinite(Number(observation.price))
    && Number(observation.price) > 0
    && Number.isFinite(Number(observation.quantity))
    && Number(observation.quantity) > 0
    && !Number.isNaN(fulfilledAt.valueOf())
    && fulfilledAt >= cutoff;
};

export const calculatePriceIndex = ({ specId, observations = [], now = new Date() } = {}) => {
  const cutoff = new Date(new Date(now).valueOf() - policy.lookbackDays * 24 * 60 * 60 * 1000);
  const eligible = observations.filter((observation) => validObservation(observation, specId, cutoff));
  const distinctSuppliers = new Set(eligible.map((observation) => observation.supplierId));
  const baseResult = {
    policyId: policy.policyId,
    specId,
    currency: policy.canonicalCurrency,
    priceUnit: policy.canonicalPriceUnit,
    quantityUnit: policy.canonicalQuantityUnit,
    windowDays: policy.lookbackDays,
    sampleSize: eligible.length,
    distinctSuppliers: distinctSuppliers.size,
    sourceStatus: policy.status,
    publication: clone(sourceContract.publication),
    provenance: eligible.map((observation) => observation.tradeId),
    priceSeries: [...eligible]
      .sort((a, b) => new Date(a.fulfilledAt) - new Date(b.fulfilledAt))
      .map((observation) => ({ fulfilledAt: observation.fulfilledAt, price: Number(observation.price) })),
  };
  if (eligible.length < policy.minCompletedTrades) {
    return { ...baseResult, status: 'UNAVAILABLE', value: null, confidence: 0, reason: 'INSUFFICIENT_COMPLETED_TRADES' };
  }
  if (distinctSuppliers.size < policy.minDistinctSuppliers) {
    return { ...baseResult, status: 'UNAVAILABLE', value: null, confidence: 0, reason: 'INSUFFICIENT_DISTINCT_SUPPLIERS' };
  }
  const totalQuantity = eligible.reduce((sum, observation) => sum + Number(observation.quantity), 0);
  const weightedValue = eligible.reduce((sum, observation) => sum + Number(observation.price) * Number(observation.quantity), 0) / totalQuantity;
  const confidence = Math.min(99, Math.round(60 + (eligible.length / (eligible.length + 3)) * 30 + (distinctSuppliers.size / (distinctSuppliers.size + 2)) * 10));
  return {
    ...baseResult,
    status: 'AVAILABLE',
    value: Math.round(weightedValue),
    confidence,
    totalQuantity,
    reason: 'SUFFICIENT_COMPLETED_EVIDENCED_TRADES',
  };
};
