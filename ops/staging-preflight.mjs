import { spawnSync } from 'node:child_process';

const hasValue = (env, key) => typeof env?.[key] === 'string' && env[key].trim().length > 0;

const probeCommand = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
  return !result.error && result.status === 0;
};

export const buildStagingPreflight = ({ env = process.env, commandAvailability = {} } = {}) => {
  const checks = [
    { id: 'NODE_RUNTIME', ready: Number(process.versions.node.split('.')[0]) >= 22, evidence: 'node --version' },
    { id: 'PG_DRIVER', ready: Boolean(commandAvailability.pgDriver), evidence: 'package.json:pg' },
    { id: 'DOCKER_ENGINE', ready: Boolean(commandAvailability.docker), evidence: 'docker --version' },
    { id: 'PERSISTENCE_MODE', ready: env.PERSISTENCE_MODE === 'postgresql', evidence: 'PERSISTENCE_MODE=postgresql' },
    { id: 'DATABASE_URL', ready: hasValue(env, 'DATABASE_URL'), evidence: 'DATABASE_URL is configured' },
    { id: 'DATABASE_ADMIN_URL', ready: hasValue(env, 'DATABASE_ADMIN_URL'), evidence: 'DATABASE_ADMIN_URL is configured' },
    { id: 'OBJECT_STORAGE_ENDPOINT', ready: hasValue(env, 'OBJECT_STORAGE_ENDPOINT'), evidence: 'OBJECT_STORAGE_ENDPOINT is configured' },
    { id: 'OBJECT_STORAGE_BUCKET', ready: hasValue(env, 'OBJECT_STORAGE_BUCKET'), evidence: 'OBJECT_STORAGE_BUCKET is configured' },
    { id: 'OBJECT_STORAGE_ACCESS_KEY', ready: hasValue(env, 'OBJECT_STORAGE_ACCESS_KEY'), evidence: 'OBJECT_STORAGE_ACCESS_KEY is configured' },
    { id: 'OBJECT_STORAGE_SECRET_KEY', ready: hasValue(env, 'OBJECT_STORAGE_SECRET_KEY'), evidence: 'OBJECT_STORAGE_SECRET_KEY is configured' },
    { id: 'OBJECT_STORAGE_REGION', ready: hasValue(env, 'OBJECT_STORAGE_REGION'), evidence: 'OBJECT_STORAGE_REGION is configured' },
  ];
  const missing = checks.filter((check) => !check.ready).map((check) => check.id);
  return {
    schemaVersion: 'STAGING-PREFLIGHT-0.1',
    status: missing.length ? 'BLOCKED' : 'READY',
    checks,
    missing,
    secretValuesRedacted: true,
    stopRule: '필수 사전점검이 하나라도 실패하면 PostgreSQL 마이그레이션·실거래·공개를 시작하지 않는다.',
  };
};

const pgDriverAvailable = async () => {
  try {
    await import('pg');
    return true;
  } catch {
    return false;
  }
};

const result = buildStagingPreflight({
  commandAvailability: {
    docker: probeCommand('docker'),
    pgDriver: await pgDriverAvailable(),
  },
});

console.log(JSON.stringify({ ...result, checkedAt: new Date().toISOString() }));
if (process.argv.includes('--strict') && result.status !== 'READY') process.exitCode = 2;

