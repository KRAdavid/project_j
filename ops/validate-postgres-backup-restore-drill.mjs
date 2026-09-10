import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = await readFile(resolve(root, 'ops/postgres-backup-restore-drill.mjs'), 'utf8');
for (const token of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'pg_dump', 'pg_restore', 'ledger_snapshots', 'operational_approvals', 'reserve_lot', 'drop database if exists']) {
  assert.match(script, new RegExp(token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'), 'i'), `복구 리허설 구성 누락: ${token}`);
}
console.log('postgres backup-restore drill contract: PASS');

