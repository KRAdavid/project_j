import assert from 'node:assert/strict';
import { buildStagingPreflight } from './staging-preflight.mjs';

const blocked = buildStagingPreflight({
  env: { PERSISTENCE_MODE: 'memory', DATABASE_URL: '' },
  commandAvailability: { docker: false, pgDriver: false },
});
assert.equal(blocked.status, 'BLOCKED');
assert.deepEqual(blocked.missing, [
  'PG_DRIVER',
  'DOCKER_ENGINE',
  'PERSISTENCE_MODE',
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ACCESS_KEY',
  'OBJECT_STORAGE_SECRET_KEY',
  'OBJECT_STORAGE_REGION',
]);
assert.equal(blocked.secretValuesRedacted, true);

const ready = buildStagingPreflight({
  env: {
    PERSISTENCE_MODE: 'postgresql',
    DATABASE_URL: 'postgresql://user:password@db.example/raw_material_os',
    DATABASE_ADMIN_URL: 'postgresql://user:password@db.example/postgres',
    OBJECT_STORAGE_ENDPOINT: 'https://objects.example',
    OBJECT_STORAGE_BUCKET: 'raw-material-evidence',
    OBJECT_STORAGE_ACCESS_KEY: 'access-key',
    OBJECT_STORAGE_SECRET_KEY: 'secret-key',
    OBJECT_STORAGE_REGION: 'us-east-1',
  },
  commandAvailability: { docker: true, pgDriver: true },
});
assert.equal(ready.status, 'READY');
assert.deepEqual(ready.missing, []);
assert.equal(JSON.stringify(ready).includes('password'), false);
console.log('staging preflight tests: PASS');

