import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-shadow-pilot-'));
const output = join(tempRoot, 'shadow-pilot.json');
try {
  const result = spawnSync(process.execPath, ['ops/run-shadow-pilot.mjs', '--output', output], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.decision, 'PASS_REVIEW_REQUIRED');
  assert.equal(report.scenario_count, 7);
  assert.equal(report.passed_scenario_count, 7);
  assert.equal(report.real_transactions_enabled, false);
  assert.equal(report.real_money_enabled, false);
  assert.equal(report.participant_access_enabled, false);
  assert.equal(report.preflight.passed, true);
  assert.ok(Object.values(report.preflight.checks).every(Boolean));
  const blockedScenarios = report.results.filter((item) => item.expected === 'BLOCKED_BEFORE_TRADE');
  assert.ok(blockedScenarios.every((item) => item.scenario_blocked_event_count > 0));
  assert.ok(blockedScenarios.every((item) => item.scenario_invalid_lot_trade_count === 0));
  console.log('shadow pilot integration tests: PASS');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

