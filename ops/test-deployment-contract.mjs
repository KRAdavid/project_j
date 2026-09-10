import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFile(resolve(root, path), 'utf8');

const dockerfile = await read('Dockerfile');
const dockerignore = await read('.dockerignore');
const workflow = await read('.github/workflows/container-release.yml');
const guide = await read('배포_운영_가이드_v0.1.md');
const packageJson = JSON.parse(await read('package.json'));

assert.match(dockerfile, /FROM node:22-bookworm-slim/);
assert.match(dockerfile, /pnpm install --frozen-lockfile --prod/);
assert.match(dockerfile, /USER node/);
assert.match(dockerfile, /api\/health/);
assert.match(dockerfile, /PERSISTENCE_MODE=postgresql/);
assert.match(dockerignore, /\.env\.\*/);
assert.match(dockerignore, /node_modules/);
assert.match(workflow, /quality-gates\.yml|Validate deployment contract/);
assert.match(workflow, /docker\/build-push-action@v6/);
assert.match(workflow, /ghcr\.io/);
assert.match(workflow, /github\.event_name == 'push' \|\| inputs\.publish == 'true'/);
assert.match(workflow, /packages:\s+write/);
assert.match(guide, /프로덕션 자동 배포는 의도적으로 제공하지 않습니다/);
assert.equal(packageJson.packageManager, 'pnpm@11.19.0');

console.log('deployment contract: PASS');

