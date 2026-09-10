import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = await readFile(resolve(root, 'ops/register-company-mode-task.ps1'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
for (const required of [
  'start-company-supervised.ps1',
  'SCHEDULED_TASK_ALREADY_EXISTS',
  'ReplaceExisting',
  'SCHEDULED_TASK_ADMIN_REQUIRED',
  'WindowsPrincipal',
  'New-ScheduledTaskTrigger -AtLogOn',
  'New-ScheduledTaskSettingsSet',
  'RestartCount 3',
  'RunLevel Limited',
  'COMPANY_MODE_TASK_REGISTERED',
]) {
  assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), `missing task registration guard: ${required}`);
}
assert.equal(packageJson.scripts['ops:register'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops/register-company-mode-task.ps1');
assert.match(script, /-LogonType\s+Interactive\b/, 'task must use a valid interactive logon type');
assert.doesNotMatch(script, /InteractiveToken/, 'task must not use an unsupported logon type');
assert.match(script, /Register-ScheduledTask[\s\S]*-ErrorAction Stop/, 'registration failures must stop before success output');
assert.match(script, /Get-ScheduledTask -TaskName \$TaskName -ErrorAction Stop/, 'registration must be verified after creation');
assert.doesNotMatch(script, /git\s+(push|commit)/i);
console.log('company mode scheduled-task contract: PASS');

