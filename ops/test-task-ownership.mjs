import assert from 'node:assert/strict';
import { validateTaskQueue } from './task-ownership.mjs';

const roster = {
  humanApprovalPrincipal: 'H-01',
  members: [
    { id: 'H-01', name: '사업총괄', kind: 'HUMAN', autonomy: 'FINAL_DECISION' },
    { id: 'AI-01', name: '세온', kind: 'AI', autonomy: 'ANALYZE_PREPARE' },
  ],
};
const validTask = {
  id: 'TASK-TEST-001',
  status: 'working',
  objective: '업무 오케스트레이션 계약을 검증한다.',
  ownerAi: 'AI-01 세온',
  reviewers: ['AI-01 세온'],
  humanGate: 'approval',
  outOfScope: 'H-01 승인 전 실제 거래·계약·결제·운영 재개',
};
assert.deepEqual(validateTaskQueue({ roster, queue: { tasks: [validTask] } }), []);
assert.match(validateTaskQueue({
  roster,
  queue: { tasks: [{ ...validTask, ownerAi: 'AI-99 유령', reviewers: [], humanGate: 'none', outOfScope: '자동 실행' }] },
})[0], /owner is not in team roster/);
assert.ok(validateTaskQueue({
  roster,
  queue: { tasks: [{ ...validTask, reviewers: ['H-01 사업총괄'] }] },
}).some((error) => error.includes('reviewer must be an analysis/prepare AI')));
console.log('task ownership tests: PASS');

