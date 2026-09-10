import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireOperationLock, OperationLockError } from './operation-lock.mjs';

const root = await mkdtemp(join(tmpdir(), 'raw-material-operation-lock-'));
const lockPath = join(root, 'nested', 'operations.lock');
try {
  const first = await acquireOperationLock(lockPath);
  await assert.rejects(() => acquireOperationLock(lockPath), (error) => error instanceof OperationLockError && error.code === 'OPERATION_ALREADY_RUNNING');
  await first.release();
  const second = await acquireOperationLock(lockPath);
  await second.release();
  await writeFile(lockPath, `${JSON.stringify({ pid: 2147483647, createdAt: new Date().toISOString() })}\n`, 'utf8');
  const recovered = await acquireOperationLock(lockPath);
  await recovered.release();
  console.log('operation lock tests: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}

