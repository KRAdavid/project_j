import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFile(resolve(root, path), 'utf8');

const packageJson = JSON.parse(await read('package.json'));
const scripts = Object.values(packageJson.scripts || {}).join('\n');
const referencedFiles = [...scripts.matchAll(/(?:ops|beta-app)\/[A-Za-z0-9_.-]+\.(?:mjs|ps1|json)/g)].map((match) => match[0]);
const uniqueReferences = [...new Set(referencedFiles)];
assert.ok(uniqueReferences.length > 0, 'package scripts must reference runnable source files');
for (const relativePath of uniqueReferences) await access(resolve(root, relativePath));

const boundary = await read('PUBLIC_RELEASE_SCOPE.md');
assert.match(boundary, /simulation-only/i, 'public release boundary must remain simulation-only');
assert.match(boundary, /private runtime state/i, 'public release boundary must exclude private runtime state');

const gitignore = await read('.gitignore');
for (const protectedPattern of ['.env', 'ops/latest-', 'ops/incident-ledger.jsonl', 'ops/company-mode-runtime.json']) {
  assert.match(gitignore, new RegExp(protectedPattern.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), `missing protected ignore pattern: ${protectedPattern}`);
}

for (const required of ['ops/company-supervisor.mjs', 'ops/ops-daemon.mjs', 'ops/run-ops-cycle.mjs', 'ops/validate-contracts.mjs']) await access(resolve(root, required));
console.log(JSON.stringify({ status: 'PASS', referencedFiles: uniqueReferences.length, guardrail: 'public source bundle is reproducible and private runtime state remains excluded' }));

