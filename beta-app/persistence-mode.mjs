import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = resolve(fileURLToPath(new URL('../data/persistence-config.json', import.meta.url)));
const config = JSON.parse(readFileSync(configPath, 'utf8'));

export const persistenceStatus = () => ({
  mode: config.currentMode,
  productionMode: config.productionMode,
  durable: config.currentMode === config.productionMode,
  failClosed: config.currentMode !== config.productionMode,
  requiredForProduction: [...config.productionRequired],
});

export const assertProductionCutover = ({ databaseUrl, schemaApplied, backupDrillPassed, isolationVerified, auditPolicyApplied, objectStorageReady, evidenceStoreReady, authProviderReady, authJwtSecret, authJwtIssuer, authJwtAudience, postgresDomainAdapterReady, postgresDomainApiReady, postgresDomainReconciliationVerified } = {}) => {
  const checks = {
    databaseUrl: Boolean(databaseUrl),
    schemaApplied: schemaApplied === true,
    backupDrillPassed: backupDrillPassed === true,
    isolationVerified: isolationVerified === true,
    auditPolicyApplied: auditPolicyApplied === true,
    objectStorageReady: objectStorageReady === true,
    evidenceStoreReady: evidenceStoreReady === true,
    authProviderReady: authProviderReady === true,
    authJwtSecret: typeof authJwtSecret === 'string' && authJwtSecret.length >= 32,
    authJwtIssuer: typeof authJwtIssuer === 'string' && authJwtIssuer.trim().length > 0,
    authJwtAudience: typeof authJwtAudience === 'string' && authJwtAudience.trim().length > 0,
    postgresDomainAdapterReady: postgresDomainAdapterReady === true,
    postgresDomainApiReady: postgresDomainApiReady === true,
    postgresDomainReconciliationVerified: postgresDomainReconciliationVerified === true,
  };
  return { ready: Object.values(checks).every(Boolean), checks };
};
