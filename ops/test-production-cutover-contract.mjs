import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = await readFile(resolve(root, '.github/workflows/production-cutover-gate.yml'), 'utf8');

const secretBackedKeys = [
  'DATABASE_URL', 'DATABASE_ADMIN_URL', 'AUTH_PROVIDER_READY', 'AUTH_EMAIL_VERIFICATION_READY',
  'AUTH_JWT_SECRET', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE', 'TRANSACTION_ISOLATION_VERIFIED',
  'AUDIT_POLICY_APPLIED', 'OBJECT_STORAGE_READY', 'EVIDENCE_STORE_READY', 'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET', 'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY', 'OBJECT_STORAGE_REGION',
  'POSTGRES_DOMAIN_ADAPTER_READY', 'POSTGRES_DOMAIN_API_READY', 'POSTGRES_DOMAIN_RECONCILIATION_VERIFIED',
  'BUSINESS_REGISTRATION_PROVIDER_READY', 'BUSINESS_REGISTRATION_PROVIDER_URL',
  'BUSINESS_REGISTRATION_PROVIDER_API_KEY', 'PRICE_SOURCE_APPROVED', 'PRICE_SOURCE_APPROVAL_REF',
  'MONITORING_CONNECTED', 'MONITORING_HEARTBEAT_VERIFIED', 'SUPERVISOR_CONNECTED',
  'SUPERVISOR_HEARTBEAT_VERIFIED', 'SHADOW_PILOT_APPROVED', 'SHADOW_PILOT_APPROVAL_REF',
];

const missingBindings = secretBackedKeys.filter((key) => !workflow.includes(key + ': ${{ secrets.' + key + ' }}'));
assert.deepEqual(missingBindings, [], `production workflow missing secret bindings: ${missingBindings.join(', ')}`);
assert.match(workflow, /echo "PERSISTENCE_SCHEMA_APPLIED=true"/);
assert.match(workflow, /echo "BACKUP_DRILL_PASSED=true"/);
assert.match(workflow, /echo "BACKUP_DRILL_EVIDENCE_REF=/);
assert.match(workflow, /Production cutover evidence is GO, but this repository performs no automatic deployment/);
assert.doesNotMatch(workflow, /docker push|kubectl apply|wrangler deploy|vercel --prod/);

console.log(`production cutover contract: PASS (${secretBackedKeys.length} secret bindings)`);
