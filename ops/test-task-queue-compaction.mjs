import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compactTaskQueue } from './task-queue-compaction.mjs';

const temp = await mkdtemp(join(tmpdir(), 'raw-material-queue-'));
const queuePath = join(temp, 'task-queue.json');
const archivePath = join(temp, 'task-queue-archive.jsonl');
try {
  await writeFile(queuePath, `${JSON.stringify({ version: '0.1', tasks: [
    { id: 'ACTIVE-1', status: 'working' },
    { id: 'DONE-1', status: 'resolved' },
    { id: 'DONE-2', status: 'rejected' },
  ] })}\n`, 'utf8');
  const first = await compactTaskQueue(queuePath, archivePath, { generatedAt: '2026-09-09T00:00:00.000Z' });
  assert.equal(first.archivedCount, 2);
  assert.equal(first.newArchiveRecords, 2);
  assert.equal(first.remainingCount, 1);
  const second = await compactTaskQueue(queuePath, archivePath, { generatedAt: '2026-09-09T00:01:00.000Z' });
  assert.equal(second.archivedCount, 0);
  assert.equal((JSON.parse(await readFile(queuePath, 'utf8'))).tasks.length, 1);
  assert.equal((await readFile(archivePath, 'utf8')).trim().split(/\r?\n/).length, 2);
  console.log('task queue compaction tests: PASS');
} finally {
  await rm(temp, { recursive: true, force: true });
}

