import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = resolve(root, 'data/postgres-schema.sql');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.log('postgres migration: SKIP (DATABASE_URL not provided)');
  process.exit(0);
}

const { Pool } = await import('pg');
const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  const schema = await readFile(schemaPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({ status: 'PASS', schema: schemaPath, migratedAt: new Date().toISOString() }));
} finally {
  await pool.end();
}

