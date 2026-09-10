import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = 4181;
const cwd = fileURLToPath(new URL('.', import.meta.url));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd,
  env: {
    ...process.env,
    APP_ENV: 'production',
    PERSISTENCE_MODE: 'postgresql',
    DATABASE_URL: 'postgresql://127.0.0.1:1/raw_material_os',
    PERSISTENCE_SCHEMA_APPLIED: 'true',
    BACKUP_DRILL_PASSED: 'true',
    TRANSACTION_ISOLATION_VERIFIED: 'true',
    AUDIT_POLICY_APPLIED: 'true',
    OBJECT_STORAGE_READY: 'true',
    EVIDENCE_STORE_READY: 'true',
    AUTH_PROVIDER_READY: 'true',
    AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
    AUTH_JWT_ISSUER: 'raw-material-os-test',
    AUTH_JWT_AUDIENCE: 'raw-material-os-api',
    POSTGRES_DOMAIN_ADAPTER_READY: 'true',
    POSTGRES_DOMAIN_API_READY: 'true',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('상용 PostgreSQL 연결 실패 시 서버가 제한시간 내에 종료되지 않았습니다.'));
  }, 7000);
  child.once('error', reject);
  child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
});

assert.notEqual(exitCode, 0);
assert.match(output, /PostgreSQL|pg|원장|connection/i);
console.log('production fail-closed tests: PASS');
