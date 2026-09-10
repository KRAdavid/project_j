import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const readiness = JSON.parse(await readFile(resolve(root, 'ops/release-readiness.json'), 'utf8'));
const required = readiness.checks.filter((check) => check.required);
assert.ok(required.length >= 6);
assert.ok(required.every((check) => check.id && check.name && typeof check.current === 'boolean'));
assert.equal(required.some((check) => check.current === false), true, '현재 메모리 베타는 상용 GO가 될 수 없어야 합니다.');
assert.match(readiness.stopRule, /허용하지 않는다/);
assert.equal(readiness.humanApprover, 'H-01');
console.log('release readiness tests: PASS');

