import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const compose = await readFile(resolve(root, 'compose.staging.yml'), 'utf8');
const dockerfile = await readFile(resolve(root, 'Dockerfile.staging'), 'utf8');
const envExample = await readFile(resolve(root, '.env.staging.example'), 'utf8');
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
const preflight = await readFile(resolve(root, 'ops/staging-preflight.mjs'), 'utf8');

const assertions = [
  ['staging compose includes PostgreSQL 15', compose.includes('image: postgres:15')],
  ['staging compose requires secret-managed database credentials', compose.includes('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?') && !/^\s+STAGING_DATABASE_URL:/m.test(compose) && compose.includes('DATABASE_URL: ${STAGING_DATABASE_URL:?')],
  ['staging compose requires secret-managed object-storage credentials', compose.includes('MINIO_ROOT_PASSWORD: ${OBJECT_STORAGE_SECRET_KEY:?') && compose.includes('OBJECT_STORAGE_SECRET_KEY: ${OBJECT_STORAGE_SECRET_KEY:?')],
  ['staging compose includes S3-compatible object storage', compose.includes('minio/minio:') && compose.includes('raw-material-evidence')],
  ['database has a healthcheck', compose.includes('pg_isready')],
  ['object storage bucket is initialized with retry after service start', compose.includes('condition: service_started') && compose.includes('until mc alias set') && compose.includes('mc mb --ignore-existing')],
  ['staging composes schema migration before app', compose.includes('schema-migrate:') && compose.includes('service_completed_successfully') && compose.includes('ops/migrate-postgres.mjs')],
  ['staging composes beta app with a healthcheck', compose.includes('app:') && compose.includes('"4173:4173"') && compose.includes('/api/health')],
  ['staging composes automatic operations daemon', compose.includes('ops-daemon:') && compose.includes('MONITOR_BASE_URL: http://app:4173')],
  ['staging image installs the runtime dependency set', dockerfile.includes('FROM node:22') && dockerfile.includes('npm install --ignore-scripts')],
  ['staging uses PostgreSQL mode explicitly', envExample.includes('PERSISTENCE_MODE=postgresql') && envExample.includes('STAGING_DATABASE_URL=')],
  ['cutover claims default to false', envExample.includes('PERSISTENCE_SCHEMA_APPLIED=false') && envExample.includes('POSTGRES_DOMAIN_API_READY=false')],
  ['readiness diagnostics keys are represented in the environment template', [
    'DATABASE_URL=',
    'PERSISTENCE_SCHEMA_APPLIED=',
    'POSTGRES_DOMAIN_ADAPTER_READY=',
    'POSTGRES_DOMAIN_API_READY=',
    'POSTGRES_DOMAIN_RECONCILIATION_VERIFIED=',
    'AUTH_PROVIDER_READY=',
    'AUTH_JWT_SECRET=',
    'AUTH_JWT_ISSUER=',
    'AUTH_JWT_AUDIENCE=',
    'PRICE_SOURCE_APPROVED=',
    'PRICE_SOURCE_APPROVAL_REF=',
    'MONITORING_CONNECTED=',
    'MONITORING_HEARTBEAT_VERIFIED=',
    'SUPERVISOR_CONNECTED=',
    'SUPERVISOR_HEARTBEAT_VERIFIED=',
    'BACKUP_DRILL_PASSED=',
    'BACKUP_DRILL_EVIDENCE_REF=',
    'SHADOW_PILOT_APPROVED=',
    'SHADOW_PILOT_APPROVAL_REF=',
  ].every((key) => envExample.includes(key))],
  ['staging preflight covers database and evidence storage fail-closed', preflight.includes("status: missing.length ? 'BLOCKED' : 'READY'") && preflight.includes('OBJECT_STORAGE_ENDPOINT') && preflight.includes('OBJECT_STORAGE_SECRET_KEY') && preflight.includes('secretValuesRedacted: true') && preflight.includes("process.argv.includes('--strict')")],
  ['staging instructions remain in the repository README', readme.includes('compose.staging.yml')],
];

const failures = assertions.filter(([, passed]) => !passed);
if (failures.length) {
  console.error(failures.map(([name]) => `FAIL: ${name}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`staging contract tests: PASS (${assertions.length})`);
}

