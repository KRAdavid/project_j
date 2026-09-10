import { resolveMaterial } from './material-master.mjs';

const GABA_MASTER = resolveMaterial('GABA');

export const GABA_TRADE_TERMS = Object.freeze({
  currency: GABA_MASTER.tradeProfile.currency,
  priceUnit: GABA_MASTER.tradeProfile.priceUnit,
  quantityUnit: GABA_MASTER.tradeProfile.orderQuantityUnit,
});

export class TradeTermsError extends Error {
  constructor(message, code = 'TRADE_TERMS_INVALID') { super(message); this.code = code; }
}

export const resolveTradeTerms = (input = {}, fallback = GABA_TRADE_TERMS) => {
  const terms = {
    currency: String(input.currency || fallback.currency),
    priceUnit: String(input.priceUnit || fallback.priceUnit),
    quantityUnit: String(input.quantityUnit || fallback.quantityUnit),
  };
  const mismatch = Object.keys(fallback).find((key) => terms[key] !== fallback[key]);
  if (mismatch) throw new TradeTermsError(`거래 조건의 ${mismatch}가 Material Master 기준과 일치하지 않습니다.`, 'TRADE_TERMS_MISMATCH');
  return terms;
};

