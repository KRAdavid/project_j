import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = await readFile(resolve(root, 'ops/company-supervisor.mjs'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

for (const required of [
  'COMPANY_SUPERVISOR_MAX_RESTARTS',
  'COMPANY_SUPERVISOR_RESTART_WINDOW_MS',
  'COMPANY_SUPERVISOR_HEALTH_TIMEOUT_MS',
  'COMPANY_MODE_ALREADY_RUNNING',
  'HALTED_REQUIRES_H01',
  'raw-material-beta',
  'eventStream !== \'SSE\'',
  'OPS_DAEMON_STATUS_PATH',
  'daemon_status_stale',
  'taskkill.exe',
  'realTradingEnabled',
  'MONITOR_REQUIRE_SUPERVISOR',
  'MONITOR_SUPERVISOR_STATUS_PATH',
  'daemonReviewRequired',
  'lastCycleDecision',
]) {
  assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), `missing supervisor guard: ${required}`);
}
assert.match(source, /persistenceMode === 'sqlite'/, 'missing SQLite persistence branch');
assert.match(source, /'--experimental-sqlite'/, 'missing SQLite runtime flag');
assert.equal(packageJson.scripts['ops:supervise'], 'node ops/company-supervisor.mjs');
assert.doesNotMatch(source, /git\\s+(push|commit)/i);
console.log('company supervisor contract: PASS');

