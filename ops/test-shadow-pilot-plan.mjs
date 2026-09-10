import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const plan = JSON.parse(await readFile(resolve(root, 'ops', 'shadow-pilot-plan.json'), 'utf8'));

assert.equal(plan.mode, 'CLOSED_SIMULATION');
assert.equal(plan.realTransactionsEnabled, false);
assert.equal(plan.realMoneyEnabled, false);
assert.equal(plan.externalNotificationsEnabled, false);
assert.equal(plan.requiredApproval, 'H-01_APPROVAL_BEFORE_PARTICIPANT_ACCESS');
assert.ok(plan.scenarios.length >= 6);
assert.ok(plan.scenarios.some((scenario) => scenario.expected === 'BLOCKED_BEFORE_TRADE'));
assert.ok(plan.scenarios.some((scenario) => scenario.expected === 'DISPUTED_AFTER_DELIVERY'));
assert.ok(plan.stopRules.length >= 4);
assert.equal(plan.successCriteria.targets.duplicate_trade_count, 0);
assert.equal(plan.successCriteria.targets.scenario_invalid_lot_trade_count, 0);
assert.equal(plan.successCriteria.targets.negative_inventory_count, 0);
for (const field of ['spec_id', 'lot_id', 'order_id', 'trade_id', 'pretrade_checks', 'state_transition_log', 'blocked_events', 'scenario_block_reason', 'invalid_lot_trade_count', 'human_decision_id']) {
  assert.ok(plan.evidenceToCapture.includes(field), `증거 필드 누락: ${field}`);
}

console.log('shadow-pilot plan tests: PASS');

