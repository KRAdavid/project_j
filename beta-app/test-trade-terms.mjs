import assert from 'node:assert/strict';
import { GABA_TRADE_TERMS, resolveTradeTerms, TradeTermsError } from './trade-terms.mjs';

assert.deepEqual(GABA_TRADE_TERMS, { currency: 'KRW', priceUnit: 'KRW_PER_KG', quantityUnit: 'KG' });
assert.deepEqual(resolveTradeTerms(), GABA_TRADE_TERMS);
assert.deepEqual(resolveTradeTerms({ currency: 'KRW', priceUnit: 'KRW_PER_KG', quantityUnit: 'KG' }), GABA_TRADE_TERMS);
assert.throws(() => resolveTradeTerms({ quantityUnit: 'MT' }), (error) => error instanceof TradeTermsError && error.code === 'TRADE_TERMS_MISMATCH');
console.log('trade-terms tests: PASS');
