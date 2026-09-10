import assert from 'node:assert/strict';
import { evaluateReleaseReadiness } from './readiness.mjs';

const result = await evaluateReleaseReadiness({ environment: 'simulation', env: { PERSISTENCE_MODE: 'memory' } });
assert.equal(result.decision, 'NO_GO');
assert.ok(result.missing.includes('R-01'));
assert.ok(result.missing.includes('R-02'));
assert.equal(result.checks.find((check) => check.id === 'R-03').current, true);
assert.match(result.stopRule, /허용하지 않는다/);
const productionEnv = {
  PERSISTENCE_MODE: 'postgresql', DATABASE_URL: 'postgres://redacted', PERSISTENCE_SCHEMA_APPLIED: 'true', POSTGRES_DOMAIN_ADAPTER_READY: 'true', POSTGRES_DOMAIN_API_READY: 'true', POSTGRES_DOMAIN_RECONCILIATION_VERIFIED: 'true',
  AUTH_PROVIDER_READY: 'true', AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-bytes-long', AUTH_JWT_ISSUER: 'issuer', AUTH_JWT_AUDIENCE: 'audience',
  PRICE_SOURCE_APPROVED: 'true', PRICE_SOURCE_APPROVAL_REF: 'PRICE-APPROVAL-001',
  MONITORING_CONNECTED: 'true', MONITORING_HEARTBEAT_VERIFIED: 'true', SUPERVISOR_CONNECTED: 'true', SUPERVISOR_HEARTBEAT_VERIFIED: 'true',
  BACKUP_DRILL_PASSED: 'true', BACKUP_DRILL_EVIDENCE_REF: 'BACKUP-001',
  SHADOW_PILOT_APPROVED: 'true', SHADOW_PILOT_APPROVAL_REF: 'SHADOW-001',
};
const production = await evaluateReleaseReadiness({ environment: 'production', env: productionEnv });
assert.equal(production.decision, 'GO');
assert.deepEqual(production.missing, []);
const missingReference = await evaluateReleaseReadiness({ environment: 'production', env: { ...productionEnv, PRICE_SOURCE_APPROVAL_REF: '' } });
assert.equal(missingReference.decision, 'NO_GO');
assert.ok(missingReference.missing.includes('R-04'));
console.log('readiness tests: PASS');
