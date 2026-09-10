import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendWorkPacket, buildWorkPacket, forbiddenActions } from './work-packet.mjs';

const run = {
  runId: 'AUTOPILOT-TEST-WORK-PACKET',
  generatedAt: '2026-09-09T00:00:00.000Z',
  decision: 'HUMAN_REVIEW_REQUIRED',
  selectedTask: { id: 'TASK-TEST-001', objective: '검증 업무', ownerAi: 'AI-10 아틀라스', reviewers: ['AI-11 실드'], risk: 'critical', nextAction: '증거를 확인한다.' },
  evidence: [{ name: 'pass', passed: true, skipped: false }, { name: 'postgres', passed: true, skipped: true }],
};
const packet = buildWorkPacket({ run });
assert.equal(packet.status, 'EVIDENCE_GAP');
assert.equal(packet.taskId, 'TASK-TEST-001');
assert.equal(packet.ownerAi, 'AI-10 아틀라스');
assert.deepEqual(packet.evidenceSummary, { total: 2, passed: 2, failed: 0, skipped: 1 });
assert.deepEqual(packet.forbiddenActions, forbiddenActions);
assert.equal(packet.humanGate, 'approval');
const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-work-packet-'));
try {
  const path = join(tempRoot, 'work-packets.jsonl');
  await appendWorkPacket(path, packet);
  assert.equal((await readFile(path, 'utf8')).trim().split(/\r?\n/).length, 1);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
console.log('work packet tests: PASS');

