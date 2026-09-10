const hasValue = (env, key) => typeof env?.[key] === 'string' ? env[key].trim().length > 0 : Boolean(env?.[key]);
const hasSecret = (env, key, minimumLength = 32) => typeof env?.[key] === 'string' && env[key].length >= minimumLength;

const requirementDefinitions = {
  'R-01': [
    ['PERSISTENCE_MODE', (env) => env.PERSISTENCE_MODE === 'postgresql'],
    ['DATABASE_URL', (env) => hasValue(env, 'DATABASE_URL')],
    ['PERSISTENCE_SCHEMA_APPLIED', (env) => env.PERSISTENCE_SCHEMA_APPLIED === 'true'],
    ['POSTGRES_DOMAIN_ADAPTER_READY', (env) => env.POSTGRES_DOMAIN_ADAPTER_READY === 'true'],
    ['POSTGRES_DOMAIN_API_READY', (env) => env.POSTGRES_DOMAIN_API_READY === 'true'],
    ['POSTGRES_DOMAIN_RECONCILIATION_VERIFIED', (env) => env.POSTGRES_DOMAIN_RECONCILIATION_VERIFIED === 'true'],
  ],
  'R-02': [
    ['AUTH_PROVIDER_READY', (env) => env.AUTH_PROVIDER_READY === 'true'],
    ['AUTH_JWT_SECRET', (env) => hasSecret(env, 'AUTH_JWT_SECRET')],
    ['AUTH_JWT_ISSUER', (env) => hasValue(env, 'AUTH_JWT_ISSUER')],
    ['AUTH_JWT_AUDIENCE', (env) => hasValue(env, 'AUTH_JWT_AUDIENCE')],
  ],
  'R-04': [
    ['PRICE_SOURCE_APPROVED', (env) => env.PRICE_SOURCE_APPROVED === 'true'],
    ['PRICE_SOURCE_APPROVAL_REF', (env) => hasValue(env, 'PRICE_SOURCE_APPROVAL_REF')],
  ],
  'R-05': [
    ['MONITORING_CONNECTED', (env) => env.MONITORING_CONNECTED === 'true'],
    ['MONITORING_HEARTBEAT_VERIFIED', (env) => env.MONITORING_HEARTBEAT_VERIFIED === 'true'],
    ['SUPERVISOR_CONNECTED', (env) => env.SUPERVISOR_CONNECTED === 'true'],
    ['SUPERVISOR_HEARTBEAT_VERIFIED', (env) => env.SUPERVISOR_HEARTBEAT_VERIFIED === 'true'],
  ],
  'R-06': [
    ['BACKUP_DRILL_PASSED', (env) => env.BACKUP_DRILL_PASSED === 'true'],
    ['BACKUP_DRILL_EVIDENCE_REF', (env) => hasValue(env, 'BACKUP_DRILL_EVIDENCE_REF')],
  ],
  'R-07': [
    ['SHADOW_PILOT_APPROVED', (env) => env.SHADOW_PILOT_APPROVED === 'true'],
    ['SHADOW_PILOT_APPROVAL_REF', (env) => hasValue(env, 'SHADOW_PILOT_APPROVAL_REF')],
  ],
};

export const buildReadinessDiagnostics = ({ environment = 'simulation', env = process.env } = {}) => Object.entries(requirementDefinitions).map(([id, requirements]) => {
  const missing = requirements.filter(([, predicate]) => !(environment === 'production' ? predicate(env) : false)).map(([key]) => key);
  return {
    id,
    status: missing.length ? 'MISSING' : 'READY',
    missing,
    checkedKeys: requirements.map(([key]) => key),
    secretValuesRedacted: true,
  };
});

export { requirementDefinitions };
