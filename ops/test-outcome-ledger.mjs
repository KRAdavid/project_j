import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeGoalContract } from './goal-contract.mjs';
import { appendOutcomeObservation, calculateGoalProgress, readOutcomeObservations } from './outcome-ledger.mjs';

const dir = await mkdtemp(join(tmpdir(), 'raw-material-goal-'));
const path = join(dir, 'outcomes.jsonl');
const contract = normalizeGoalContract({ intent: '검증', goalArchetypes: ['VALIDATION'], definitionOfDone: [
  { predicateId: 'A', predicate: 'A 완료', evidenceType: 'TEST', evaluator: 'AI', threshold: 1 },
  { predicateId: 'B', predicate: 'B 완료', evidenceType: 'TEST', evaluator: 'H-01', threshold: 1 },
] });
await appendOutcomeObservation(path, { outcomeId: 'A', source: 'test', evidenceLevel: 'VERIFIED', confidence: 0.9, satisfied: true });
const observations = await readOutcomeObservations(path);
const progress = calculateGoalProgress({ contract, observations });
assert.equal(observations.length, 1);
assert.equal(progress.score, 0.5);
assert.equal(progress.satisfiedCount, 1);
await rm(dir, { recursive: true, force: true });
console.log('outcome ledger tests: PASS');

