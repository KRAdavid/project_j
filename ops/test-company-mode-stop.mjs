import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = await readFile(resolve(root, 'ops/stop-company-mode.ps1'), 'utf8');
for (const required of [
  'company-mode-runtime.json',
  'COMPANY-MODE-RUNTIME-0.1',
  'opsDaemonPid',
  'supervisorPid',
  'serverPid',
  'Stop-Process -Id',
  'attempt -lt 20',
  "status = 'STOPPED'",
  'stoppedAt',
  'Clear-StaleOperationLock',
  '.operations-cycle.lock',
  'Get-Process -Id $lockPid',
]) {
  assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing stop guard: ${required}`);
}
assert.doesNotMatch(script, /Remove-Item\s+.*company-mode-runtime|taskkill\.exe/i, 'stop must preserve the runtime manifest and avoid broad process termination');
console.log('company mode stop contract: PASS');

