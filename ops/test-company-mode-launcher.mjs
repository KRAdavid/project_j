import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const launcher = await readFile(resolve(root, 'ops', 'start-company-mode.ps1'), 'utf8');
const supervisedLauncher = await readFile(resolve(root, 'ops', 'start-company-supervised.ps1'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

for (const required of [
  'beta-app/server.mjs',
  'ops/ops-daemon.mjs',
  '/api/health',
  "health.service -eq 'raw-material-beta'",
  "health.eventStream -eq 'SSE'",
  'PORT_IN_USE',
  'SERVER_HEALTH_TIMEOUT',
  'DAEMON_ALREADY_RUNNING',
  'daemon-status.json',
  'CYCLE_RUNNING',
  'realTradingEnabled = $false',
  'externalNotificationSent = $false',
  'Stop-Process -Id',
  'serverPid = $serverProcess.Id',
  'COMPANY_MODE_STARTED',
  'MONITOR_BASE_URL',
  "MONITOR_REQUIRE_DAEMON = 'true'",
  'MONITOR_DAEMON_STATUS_PATH',
  'OPS_DAEMON_STATUS_PATH',
  'monitorBaseUrl = $env:MONITOR_BASE_URL',
  'daemonRequired = $true',
  'minimumCycleTimeoutMs = 300000',
  'CYCLE_TIMEOUT_TOO_SHORT',
]) {
  assert.match(launcher, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing launcher guard: ${required}`);
}

assert.doesNotMatch(launcher, /git\s+(push|commit)|Invoke-WebRequest.*POST|taskkill\.exe/i, 'launcher must not write to GitHub or use broad process termination');
for (const required of ['company-supervisor.mjs', 'COMPANY_MODE_ALREADY_RUNNING', 'SUPERVISED_SERVER_HEALTH_TIMEOUT', 'COMPANY_MODE_SUPERVISED_STARTED', 'realTradingEnabled']) {
  assert.match(supervisedLauncher, new RegExp(required.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), `missing supervised launcher guard: ${required}`);
}
assert.doesNotMatch(supervisedLauncher, /git\s+(push|commit)/i, 'supervised launcher must not write to GitHub');
assert.equal(packageJson.scripts['ops:start'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops/start-company-supervised.ps1');
assert.equal(packageJson.scripts['ops:start:basic'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops/start-company-mode.ps1');
console.log('company mode launcher contract: PASS');

