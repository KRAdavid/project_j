import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTaskTimeline } from './task-audit-integrity.mjs';
import { parseOperationalTimestamp } from './operational-time.mjs';

assert.equal(parseOperationalTimestamp('2026-09-09 오후 9:30:23'), Date.parse('2026-09-09T12:30:23.000Z'));
assert.equal(parseOperationalTimestamp('not-a-time'), null);

const root = await mkdtemp(join(tmpdir(), 'raw-material-task-audit-'));
const queuePath = join(root, 'task-queue.json');
const archivePath = join(root, 'task-queue-archive.jsonl');
const invalid = { id: 'AUTO-BAD-001', status: 'resolved', createdAt: '2026-09-09 오후 9:30:23', enqueuedAt: '2026-09-09 오후 9:30:23', resolvedAt: '2026-09-09 오후 9:28:41', updatedAt: '2026-09-09 오후 9:28:41' };
await writeFile(queuePath, JSON.stringify({ tasks: [] }), 'utf8');
await writeFile(archivePath, `${JSON.stringify({ schemaVersion: 'TASK-QUEUE-ARCHIVE-0.1', archivedAt: '2026-09-09T12:40:00.000Z', task: invalid })}\n`, 'utf8');
const repaired = await auditTaskTimeline({ queuePath, archivePath, generatedAt: '2026-09-10T00:00:00.000Z' });
assert.equal(repaired.status, 'CORRECTED_ARCHIVE_TIMELINE');
assert.equal(repaired.correctedCount, 1);
assert.equal(repaired.remainingArchiveViolationCount, 0);
const replay = await auditTaskTimeline({ queuePath, archivePath, generatedAt: '2026-09-10T00:01:00.000Z' });
assert.equal(replay.status, 'VALID');
assert.equal(replay.correctedCount, 0);
const lines = (await readFile(archivePath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(lines.length, 2);
assert.equal(lines[1].schemaVersion, 'TASK-QUEUE-AUDIT-CORRECTION-0.1');

const activeQueuePath = join(root, 'active-invalid.json');
await writeFile(activeQueuePath, JSON.stringify({ tasks: [{ ...invalid, id: 'ACTIVE-BAD-001', status: 'working' }] }), 'utf8');
const active = await auditTaskTimeline({ queuePath: activeQueuePath, archivePath: join(root, 'empty.jsonl'), generatedAt: '2026-09-10T00:00:00.000Z' });
assert.equal(active.status, 'ACTIVE_TIMELINE_INVALID');
assert.equal(active.correctedCount, 0);
await rm(root, { recursive: true, force: true });
console.log('task audit integrity tests: PASS');


