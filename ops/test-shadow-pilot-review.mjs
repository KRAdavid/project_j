import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateShadowPilotReview } from './shadow-pilot-review.mjs';

const validReport = {
  decision: 'PASS_REVIEW_REQUIRED',
  mode: 'CLOSED_SIMULATION',
  real_transactions_enabled: false,
  real_money_enabled: false,
  external_notifications_enabled: false,
  participant_access_enabled: false,
  scenario_count: 7,
  passed_scenario_count: 7,
  preflight: { passed: true, checks: { closed: true, sideEffects: true, humanGate: true } },
  results: Array.from({ length: 7 }, (_, index) => ({
    scenario_id: `SP-${index + 1}`,
    passed: true,
    scenario_invalid_lot_trade_count: 0,
  })),
};

const ready = evaluateShadowPilotReview({ report: validReport });
assert.equal(ready.ready, true);
assert.equal(ready.invalidLotTradeCount, 0);
assert.ok(ready.evidenceRefs.includes('ops/latest-shadow-pilot.json'));

const unsafeReport = {
  ...validReport,
  participant_access_enabled: true,
};
const unsafe = evaluateShadowPilotReview({ report: unsafeReport });
assert.equal(unsafe.ready, false);
assert.equal(unsafe.checks.participantAccessDisabled, false);
assert.deepEqual(unsafe.evidenceRefs, []);

const latest = JSON.parse(await readFile(new URL('./latest-shadow-pilot.json', import.meta.url), 'utf8'));
const latestReview = evaluateShadowPilotReview({ report: latest });
assert.equal(latestReview.ready, true);
console.log(JSON.stringify({ status: 'PASS', valid: ready.ready, unsafe: unsafe.ready, latest: latestReview.ready }));

