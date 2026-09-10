import assert from 'node:assert/strict';
import { normalizeGoalContract, validateGoalContract } from './goal-contract.mjs';

const contract = normalizeGoalContract({
  intent: 'GABA 원료 거래 베타를 검증한다.',
  goalArchetypes: ['VALIDATION'],
  definitionOfDone: [{ predicateId: 'CHECKED', predicate: '검증 완료', evidenceType: 'TEST', evaluator: 'AI-09', threshold: 1 }],
});
assert.equal(contract.schemaVersion, 'UNIVERSAL-GOAL-CONTRACT-2.0');
assert.equal(contract.authorityProfile.humanApprovalPrincipal, 'H-01');
assert.equal(validateGoalContract(contract).length, 0);
assert.throws(() => normalizeGoalContract({ intent: 'x', definitionOfDone: [] }), /GOAL_CONTRACT_INVALID/);
console.log('goal contract tests: PASS');

