import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const policy = JSON.parse(await readFile(resolve(root, 'data', 'team-autonomy-policy.json'), 'utf8'));
const requiredStatuses = ['AUTO_EXECUTING', 'AUTO_QUEUE_ACTIVE', 'WAITING_FOR_H01', 'UNVERIFIED_ACTIVE', 'READY_FOR_DECISION', 'IDLE'];
const aiActions = new Set(policy.automaticPreparationActions);
const gatedActions = new Set(policy.humanApprovalRequiredActions);

assert.equal(policy.schemaVersion, 'TEAM-AUTONOMY-POLICY-0.1');
assert.equal(policy.humanApprovalPrincipal, 'H-01');
assert.equal(policy.truthModel, 'RULE_DRIVEN_AUTOMATION_NOT_CONTINUOUS_LLM_BACKGROUND_THOUGHT');
assert.ok(aiActions.size >= 4);
assert.ok(gatedActions.size >= 7);
assert.equal([...aiActions].some((action) => gatedActions.has(action)), false, '자동 수행과 승인 필요 액션은 겹치면 안 됩니다.');
assert.deepEqual(policy.executionEvidenceFields, ['claimedAt', 'startedAt', 'reviewedAt', 'lastRecheckedAt']);
for (const status of requiredStatuses) assert.equal(typeof policy.statusSemantics?.[status], 'string');
assert.match(policy.guardrail, /H-01 승인/);
console.log('team autonomy policy: PASS');
