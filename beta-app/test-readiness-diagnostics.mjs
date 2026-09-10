import assert from 'node:assert/strict';
import { buildReadinessDiagnostics } from './readiness-diagnostics.mjs';

const diagnostics = buildReadinessDiagnostics({ environment: 'production', env: {
  PERSISTENCE_MODE: 'postgresql', DATABASE_URL: 'postgres://redacted', PERSISTENCE_SCHEMA_APPLIED: 'true', POSTGRES_DOMAIN_ADAPTER_READY: 'true', POSTGRES_DOMAIN_API_READY: 'true', POSTGRES_DOMAIN_RECONCILIATION_VERIFIED: 'true',
  AUTH_PROVIDER_READY: 'true', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_JWT_ISSUER: 'issuer', AUTH_JWT_AUDIENCE: 'audience',
  PRICE_SOURCE_APPROVED: 'true', PRICE_SOURCE_APPROVAL_REF: 'PRICE-001', MONITORING_CONNECTED: 'true', MONITORING_HEARTBEAT_VERIFIED: 'true', SUPERVISOR_CONNECTED: 'true', SUPERVISOR_HEARTBEAT_VERIFIED: 'true', BACKUP_DRILL_PASSED: 'true', BACKUP_DRILL_EVIDENCE_REF: 'BACKUP-001', SHADOW_PILOT_APPROVED: 'true', SHADOW_PILOT_APPROVAL_REF: 'SHADOW-001',
} });
assert.ok(diagnostics.every((item) => item.status === 'READY' && item.missing.length === 0));
assert.ok(diagnostics.every((item) => item.secretValuesRedacted));
const missing = buildReadinessDiagnostics({ environment: 'production', env: { PERSISTENCE_MODE: 'memory' } });
assert.equal(missing.find((item) => item.id === 'R-01').status, 'MISSING');
assert.ok(missing.find((item) => item.id === 'R-01').missing.includes('DATABASE_URL'));
const simulation = buildReadinessDiagnostics({ environment: 'simulation', env: {} });
assert.ok(simulation.every((item) => item.status === 'MISSING'));
console.log('readiness diagnostics tests: PASS');
