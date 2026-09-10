import assert from 'node:assert/strict';
import { persistenceStatus, assertProductionCutover } from '../beta-app/persistence-mode.mjs';

const status = persistenceStatus();
assert.equal(status.mode, 'SIMULATION_MEMORY');
assert.equal(status.durable, false);
assert.equal(status.failClosed, true);
assert.ok(status.requiredForProduction.length >= 4);
assert.equal(assertProductionCutover({}).ready, false);
assert.equal(assertProductionCutover({ databaseUrl: 'postgres://redacted', schemaApplied: true, backupDrillPassed: true, isolationVerified: true, auditPolicyApplied: true, objectStorageReady: true, evidenceStoreReady: true, authProviderReady: true, authJwtSecret: 'test-secret-that-is-at-least-32-bytes-long', authJwtIssuer: 'issuer', authJwtAudience: 'audience', postgresDomainAdapterReady: true, postgresDomainApiReady: true, postgresDomainReconciliationVerified: true }).ready, true);
console.log('persistence config tests: PASS');

