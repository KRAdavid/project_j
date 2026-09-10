import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = outputIndex >= 0 && args[outputIndex + 1] ? resolve(root, args[outputIndex + 1]) : resolve(root, 'ops/latest-shadow-pilot.json');
const userProfile = process.env.USERPROFILE || '';
const candidates = [
  process.env.PYTHON_EXECUTABLE,
  process.env.PYTHON,
  userProfile ? resolve(userProfile, '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe') : null,
  'python',
  'python3',
].filter(Boolean);

const python = candidates.find((candidate) => existsSync(candidate) || spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0);
if (!python) {
  console.error(JSON.stringify({ status: 'INCIDENT', error: 'Shadow Pilot을 실행할 Python 런타임을 찾지 못했습니다.' }));
  process.exitCode = 1;
} else {
  const result = spawnSync(python, ['simulator/shadow_pilot_runner.py', '--output', output], { cwd: root, encoding: 'utf8' });
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (text) console.log(text);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

