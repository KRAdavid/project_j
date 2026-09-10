import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculatePriceIndex } from './price-index.mjs';
import { loadPricePolicy } from './price-index.mjs';

const contractPath = resolve(fileURLToPath(new URL('../data/price-source-contract.json', import.meta.url)));
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const pricePolicy = loadPricePolicy();

export class PriceFeedError extends Error {
  constructor(message, code = 'PRICE_FEED_FAILED') { super(message); this.code = code; }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const observationIdentity = (observation) => observation?.tradeId || observation?.quoteId || observation?.sourceId || null;

const validateObservation = (sourceType, observation) => {
  const source = contract.allowedSources.find((candidate) => candidate.sourceType === sourceType);
  if (!source) throw new PriceFeedError('허용되지 않은 가격 원천입니다.', 'PRICE_SOURCE_NOT_ALLOWED');
  const missing = source.requiredFields.find((field) => observation?.[field] === undefined || observation?.[field] === null || observation?.[field] === '');
  if (missing) throw new PriceFeedError(`가격 관측치 필드가 없습니다: ${missing}`, 'PRICE_OBSERVATION_INVALID');
  if (sourceType !== 'PUBLIC_REFERENCE' && (
    observation.currency !== pricePolicy.canonicalCurrency
    || observation.priceUnit !== pricePolicy.canonicalPriceUnit
    || observation.quantityUnit !== pricePolicy.canonicalQuantityUnit
  )) throw new PriceFeedError('가격·수량 단위 또는 통화가 기준 스펙과 일치하지 않습니다.', 'PRICE_OBSERVATION_UNIT_MISMATCH');
  if (!observationIdentity(observation)) throw new PriceFeedError('가격 관측치 식별자가 필요합니다.', 'PRICE_OBSERVATION_INVALID');
  return source;
};

export class PriceFeed {
  constructor({ publicationApproved = false, approvalRef = null } = {}) {
    this.observations = new Map();
    this.publicationApproved = Boolean(publicationApproved);
    this.approvalRef = approvalRef ? String(approvalRef) : null;
  }

  snapshot() { return [...this.observations.values()].map(clone); }

  restore(observations = []) {
    if (!Array.isArray(observations)) throw new PriceFeedError('가격 관측치 복구 형식이 올바르지 않습니다.', 'PRICE_OBSERVATION_INVALID');
    const restored = observations.map((observation) => {
      validateObservation(observation?.sourceType, observation);
      return [String(observationIdentity(observation)), clone(observation)];
    });
    this.observations = new Map(restored);
    return this.status();
  }

  ingest({ sourceType, observations = [] } = {}) {
    const source = contract.allowedSources.find((candidate) => candidate.sourceType === sourceType);
    if (!source) throw new PriceFeedError('허용되지 않은 가격 원천입니다.', 'PRICE_SOURCE_NOT_ALLOWED');
    if (!Array.isArray(observations) || observations.length === 0) throw new PriceFeedError('가격 관측치가 필요합니다.', 'PRICE_OBSERVATION_REQUIRED');
    const accepted = [];
    for (const observation of observations) {
      validateObservation(sourceType, observation);
      const identity = String(observationIdentity(observation));
      if (this.observations.has(identity)) continue;
      const normalized = { ...clone(observation), sourceType, ingestedAt: new Date().toISOString() };
      this.observations.set(identity, normalized);
      accepted.push(normalized);
    }
    return { accepted: accepted.length, acceptedObservations: accepted.map(clone), duplicateIgnored: observations.length - accepted.length, total: this.observations.size };
  }

  calculate(specId, now = new Date()) {
    const index = calculatePriceIndex({ specId, observations: [...this.observations.values()], now });
    if (index.status !== 'AVAILABLE') return { ...index, aiTrend: { status: 'UNAVAILABLE', direction: null, changePct: null, label: '표본 부족으로 추세를 산출하지 않음' } };
    if (!this.publicationApproved) return {
      ...index,
      status: 'PENDING_HUMAN_APPROVAL',
      value: null,
      confidence: 0,
      reason: 'PRICE_PUBLICATION_APPROVAL_REQUIRED',
      aiTrend: { status: 'UNAVAILABLE', direction: null, changePct: null, label: '인간 공개 승인 전에는 가격·추세를 공개하지 않음' },
    };
    const eligible = [...this.observations.values()]
      .filter((observation) => index.provenance.includes(observation.tradeId))
      .sort((a, b) => new Date(a.fulfilledAt) - new Date(b.fulfilledAt));
    const midpoint = Math.max(1, Math.floor(eligible.length / 2));
    const average = (items) => items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0) / items.reduce((sum, item) => sum + Number(item.quantity), 0);
    const first = average(eligible.slice(0, midpoint));
    const last = average(eligible.slice(midpoint));
    const changePct = Number((((last - first) / first) * 100).toFixed(2));
    const direction = changePct > 1 ? 'UPWARD' : changePct < -1 ? 'DOWNWARD' : 'STABLE';
    return { ...index, aiTrend: { status: 'AVAILABLE', direction, changePct, label: direction === 'UPWARD' ? '상승 추세' : direction === 'DOWNWARD' ? '하락 추세' : '보합 추세', disclaimer: contract.publication.modelPredictionLabel } };
  }

  status() { return { sourceStatus: contract.status, observationCount: this.observations.size, publicationApproved: this.publicationApproved, approvalRef: this.approvalRef, publicationApprovalRequired: contract.publication.humanApprovalRequired, rawSupplierIdentityPublic: contract.publication.rawSupplierIdentityPublic }; }
}
