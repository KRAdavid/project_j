import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const contract = JSON.parse(await readFile(resolve(root, 'data/price-source-contract.json'), 'utf8'));
const policy = JSON.parse(await readFile(resolve(root, 'data/price-index-policy.json'), 'utf8'));
assert.equal(contract.status, 'SIMULATION_ONLY');
assert.equal(policy.canonicalCurrency, 'KRW');
assert.equal(policy.canonicalPriceUnit, 'KRW_PER_KG');
assert.equal(policy.canonicalQuantityUnit, 'KG');
for (const field of ['currency', 'priceUnit', 'quantityUnit']) assert.ok(policy.requiredFields.includes(field), `가격 정책 필드 누락: ${field}`);
assert.ok(contract.allowedSources.length >= 3);
const published = contract.allowedSources.filter((source) => source.eligibleForPublishedIndex);
assert.deepEqual(published.map((source) => source.sourceType), ['COMPLETED_PHYSICAL_TRADE']);
for (const source of published) for (const field of ['currency', 'priceUnit', 'quantityUnit']) assert.ok(source.requiredFields.includes(field), `공개 가격원천 필드 누락: ${field}`);
for (const source of contract.allowedSources) {
  assert.ok(source.requiredFields.length >= 5, `${source.sourceType} 필수 필드가 부족합니다.`);
  assert.ok(source.refreshCadence);
}
assert.ok(contract.qualityChecks.length >= 4);
assert.equal(contract.publication.rawSupplierIdentityPublic, false);
assert.equal(contract.publication.sourceDisclosureRequired, true);
assert.equal(contract.publication.humanApprovalRequired, true);
console.log('price-source contract tests: PASS');

