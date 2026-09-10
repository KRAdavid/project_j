import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const launcher = await readFile(resolve(root, 'beta-app', 'server.ps1'), 'utf8');
assert.match(launcher, /server\.mjs/, 'PowerShell 런처는 정식 Node 서버를 실행해야 합니다.');
assert.match(launcher, /PERSISTENCE_MODE/, '런처는 원장 모드를 명시적으로 전달해야 합니다.');
assert.match(launcher, /APP_ENV/, '런처는 실행 환경을 명시적으로 전달해야 합니다.');
assert.doesNotMatch(launcher, /TcpListener/, 'API·SSE가 없는 별도 정적 서버를 유지하면 안 됩니다.');
console.log('server launcher contract: PASS');


