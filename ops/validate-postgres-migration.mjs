import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migration = await readFile(resolve(root, 'ops/migrate-postgres.mjs'), 'utf8');
const schema = await readFile(resolve(root, 'data/postgres-schema.sql'), 'utf8');

assert.match(migration, /DATABASE_URL/);
assert.match(migration, /BEGIN/);
assert.match(migration, /COMMIT/);
assert.match(migration, /ROLLBACK/);
assert.match(migration, /data\/postgres-schema\.sql/);
assert.match(schema, /do \$\$ begin create type organization_member_role/i);
assert.match(schema, /create table if not exists organizations/i);
assert.match(schema, /create unique index if not exists one_active_reservation_per_order_lot/i);
assert.match(schema, /create table if not exists ledger_snapshots/i);
assert.match(schema, /create table if not exists operational_approvals/i);
assert.match(schema, /create table if not exists trade_inspections/i);
assert.match(schema, /create or replace function reserve_lot/i);
console.log('postgres migration contract: PASS');

