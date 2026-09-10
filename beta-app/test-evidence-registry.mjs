import assert from 'node:assert/strict';
import { EvidenceRegistry, EvidenceRegistryError } from './evidence-registry.mjs';

const now = new Date('2026-09-08T00:00:00.000Z');
const registry = new EvidenceRegistry({ now: () => new Date(now) });
const types = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'];
const submitted = types.map((evidenceType) => registry.submit({
  lotId: 'LOT-001', evidenceType, documentVersion: 'v1', submittedBy: 'SUPPLIER-001', content: `LOT-001-${evidenceType}`,
  expiresAt: '2027-07-31',
}));
assert.equal(submitted[0].state, 'PENDING');
assert.equal(registry.eligibility('LOT-001').preTradeEligible, false);

assert.throws(() => registry.review(submitted[0].evidenceId, { decision: 'VALID', reviewerRole: 'AI', reviewerId: 'AI-07' }), (error) => {
  assert.ok(error instanceof EvidenceRegistryError);
  assert.equal(error.code, 'HUMAN_REVIEW_REQUIRED');
  return true;
});

for (const record of submitted) registry.review(record.evidenceId, { decision: 'VALID', reviewerRole: 'OPERATOR', reviewerId: 'OP-001' });
const eligible = registry.eligibility('LOT-001');
assert.equal(eligible.status, 'VALID');
assert.equal(eligible.preTradeEligible, true);
assert.equal(eligible.checks.filter((check) => check.valid && check.evidenceType !== 'DUPLICATE_TYPE').length, 5);
assert.equal(eligible.checks.find((check) => check.evidenceType === 'DUPLICATE_TYPE').valid, true);

assert.throws(() => registry.submit({ lotId: 'LOT-001', evidenceType: 'COA', documentVersion: 'v1', submittedBy: 'SUPPLIER-001', content: 'duplicate' }), (error) => {
  assert.ok(error instanceof EvidenceRegistryError);
  assert.equal(error.code, 'EVIDENCE_ALREADY_SUBMITTED');
  return true;
});

const rejected = registry.submit({ lotId: 'LOT-002', evidenceType: 'COA', documentVersion: 'v1', submittedBy: 'SUPPLIER-001', content: 'bad', expiresAt: '2027-07-31' });
registry.review(rejected.evidenceId, { decision: 'REJECTED', reviewerRole: 'OWNER', reviewerId: 'H-01' });
assert.equal(registry.eligibility('LOT-002').status, 'BLOCKED');

console.log('evidence-registry tests: PASS');
