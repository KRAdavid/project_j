import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendPatentDisclosurePacket, buildPatentDisclosurePacket, prohibitedActions } from './patent-disclosure-packet.mjs';

const traceability = {
  candidateTitle: '테스트 발명',
  externalReviewRequired: ['official prior-art search'],
  prohibitedExternalClaims: ['특허 등록 보장'],
  elements: [{ id: 'E1', title: '표준 스펙', technicalMechanism: '정규화', implementation: ['data/material-master.json'], tests: ['beta-app/test-material-master.mjs'], humanGate: 'H-01' }],
};
const run = { runId: 'AUTOPILOT-TEST-PATENT', generatedAt: '2026-09-09T00:00:00.000Z', decision: 'HUMAN_REVIEW_REQUIRED', selectedTask: { id: 'TASK-TEST' }, evidence: [{ name: 'pass', passed: true }, { name: 'skip', passed: true, skipped: true }] };
const packet = buildPatentDisclosurePacket({ traceability, run });
assert.equal(packet.legalStatus, 'INVENTION_DISCLOSURE_ONLY');
assert.equal(packet.patentabilityGuarantee, false);
assert.equal(packet.candidateMechanisms.length, 1);
assert.equal(packet.claimDraftingAid.status, 'ATTORNEY_DRAFT_REQUIRED');
assert.equal(packet.claimDraftingAid.independentSystemClaim.limitations.length, 1);
assert.deepEqual(packet.currentImplementationEvidence, { total: 2, passed: 2, failed: 0, skipped: 1, refs: [{ name: 'pass', passed: true, skipped: false }, { name: 'skip', passed: true, skipped: true }] });
assert.deepEqual(packet.prohibitedActions, prohibitedActions);
const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-patent-packet-'));
try {
  const path = join(tempRoot, 'patent-disclosures.jsonl');
  await appendPatentDisclosurePacket(path, packet);
  assert.equal((await readFile(path, 'utf8')).trim().split(/\r?\n/).length, 1);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
console.log('patent disclosure packet tests: PASS');

