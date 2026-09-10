import assert from 'node:assert/strict';
import { buildPatentClaimOutline } from './patent-claim-outline.mjs';

const outline = buildPatentClaimOutline({
  traceability: {
    candidateTitle: '테스트 발명',
    elements: [
      { id: 'E1', title: '스펙', technicalMechanism: '스펙을 봉인', implementation: ['a'], tests: ['t'] },
      { id: 'E4', title: '예약', technicalMechanism: '원자 예약', implementation: ['b'], tests: ['u'] },
    ],
  },
});
assert.equal(outline.status, 'ATTORNEY_DRAFT_REQUIRED');
assert.equal(outline.patentabilityGuarantee, false);
assert.equal(outline.independentSystemClaim.limitations.length, 2);
assert.equal(outline.independentSystemClaim.limitations[0].elementId, 'E1');
assert.equal(outline.independentSystemClaim.limitations[1].elementId, 'E4');
assert.equal(outline.dependentClaimCandidates.length, 6);
assert.ok(outline.priorArtReviewWarnings.length >= 3);
assert.ok(outline.evidenceBoundary.requiredBeforeExternalFiling.includes('변리사 청구항 작성'));
console.log('patent claim outline tests: PASS');


