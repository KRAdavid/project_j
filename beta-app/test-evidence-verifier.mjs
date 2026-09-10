import assert from 'node:assert/strict';
import { hashDocument, loadEvidencePolicy, verifyEvidenceBundle } from './evidence-verifier.mjs';

const now = new Date('2026-09-08T00:00:00.000Z');
const evidenceTypes = loadEvidencePolicy().requiredTypes;
const validEvidence = evidenceTypes.map((evidenceType) => ({
  evidenceId: `E-${evidenceType}`,
  lotId: 'LOT-001',
  evidenceType,
  documentVersion: 'v1',
  contentSha256: hashDocument(`LOT-001-${evidenceType}-v1`),
  state: 'VALID',
  expiresAt: '2027-07-31',
}));

const valid = verifyEvidenceBundle({ lotId: 'LOT-001', evidence: validEvidence, now });
assert.equal(valid.status, 'VALID');
assert.equal(valid.preTradeEligible, true);
assert.deepEqual(valid.missing, []);

const missing = verifyEvidenceBundle({ lotId: 'LOT-001', evidence: validEvidence.slice(0, 3), now });
assert.equal(missing.status, 'BLOCKED');
assert.deepEqual(missing.missing, ['LOT_TRACE', 'INVENTORY_PROOF']);

const expired = verifyEvidenceBundle({
  lotId: 'LOT-001',
  evidence: validEvidence.map((record) => record.evidenceType === 'COA' ? { ...record, expiresAt: '2026-09-07' } : record),
  now,
});
assert.equal(expired.status, 'BLOCKED');
assert.ok(expired.invalid.includes('COA'));

const duplicate = verifyEvidenceBundle({ lotId: 'LOT-001', evidence: [...validEvidence, { ...validEvidence[0], evidenceId: 'E-COA-OLD', documentVersion: 'v0' }], now });
assert.equal(duplicate.status, 'BLOCKED');
assert.deepEqual(duplicate.duplicateTypes, ['COA']);

const lotMismatch = verifyEvidenceBundle({ lotId: 'LOT-001', evidence: validEvidence.map((record) => record.evidenceType === 'SDS' ? { ...record, lotId: 'LOT-999' } : record), now });
assert.equal(lotMismatch.status, 'BLOCKED');
assert.ok(lotMismatch.invalid.includes('SDS'));

console.log('evidence-verifier tests: PASS');
