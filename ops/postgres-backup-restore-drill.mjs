import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.log('postgres backup-restore drill: SKIP (DATABASE_URL not provided)');
  process.exit(0);
}

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  throw new Error('DATABASE_ADMIN_URL is required for an isolated restore database.');
}

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`.trim());
  return result.stdout;
};

const restoreDb = `raw_material_os_restore_${Date.now()}_${randomUUID().slice(0, 8)}`;
if (!/^raw_material_os_restore_[a-z0-9_]+$/.test(restoreDb)) throw new Error('Unsafe restore database name.');
const workDir = resolve(tmpdir(), `raw-material-os-drill-${Date.now()}`);
const backupPath = resolve(workDir, 'raw-material-os.dump');
await mkdir(workDir, { recursive: true });

const { Pool } = await import('pg');
const sourcePool = new Pool({ connectionString: sourceUrl, max: 1 });
const adminPool = new Pool({ connectionString: adminUrl, max: 1 });
let sourcePoolClosed = false;

try {
  await sourcePool.query(
    'insert into ledger_snapshots(payload) values ($1::jsonb)',
    [JSON.stringify({ drill: 'backup-restore', nonce: randomUUID() })],
  );
  await sourcePool.end();
  sourcePoolClosed = true;

  run('pg_dump', ['--format=custom', '--no-owner', '--file', backupPath, sourceUrl]);
  await adminPool.query(`create database "${restoreDb}"`);
  const restoreUrl = new URL(sourceUrl);
  restoreUrl.pathname = `/${restoreDb}`;
  run('pg_restore', ['--exit-on-error', '--no-owner', '--dbname', restoreUrl.toString(), backupPath]);

  const restoredPool = new Pool({ connectionString: restoreUrl.toString(), max: 1 });
  try {
    const checks = await Promise.all([
      restoredPool.query("select to_regclass('public.ledger_snapshots') as table_name"),
      restoredPool.query("select to_regclass('public.operational_approvals') as table_name"),
      restoredPool.query("select to_regprocedure('public.reserve_lot(uuid,text,numeric,text)') as function_name"),
      restoredPool.query('select count(*)::integer as count from ledger_snapshots'),
    ]);
    if (!checks[0].rows[0].table_name || !checks[1].rows[0].table_name || !checks[2].rows[0].function_name) {
      throw new Error('복원된 핵심 원장·승인·예약 함수가 확인되지 않았습니다.');
    }
    if (checks[3].rows[0].count < 1) throw new Error('복원된 원장 데이터가 비어 있습니다.');
    console.log(JSON.stringify({ status: 'PASS', restoreDb, restoredLedgerRows: checks[3].rows[0].count, checkedAt: new Date().toISOString() }));
  } finally {
    await restoredPool.end();
  }
} finally {
  if (!sourcePoolClosed) await sourcePool.end();
  try { await adminPool.query(`drop database if exists "${restoreDb}"`); } finally {
    await adminPool.end();
    await rm(workDir, { recursive: true, force: true });
  }
}

