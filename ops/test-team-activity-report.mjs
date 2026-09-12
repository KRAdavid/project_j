import assert from 'node:assert/strict';
import { buildTeamActivityReport } from './team-activity-report.mjs';

const roster = [
  { id: 'H-01', kind: 'HUMAN', name: '사업총괄', role: '최종 승인', autonomy: 'FINAL_DECISION' },
  { id: 'AI-01', kind: 'AI', name: '세온', role: 'PMO', autonomy: 'ANALYZE_PREPARE' },
  { id: 'AI-10', kind: 'AI', name: '아틀라스', role: '아키텍처', autonomy: 'ANALYZE_PREPARE' },
  { id: 'AI-05', kind: 'AI', name: '트렌디', role: '가격', autonomy: 'ANALYZE_PREPARE' },
];
const tasks = [
  { id: 'TASK-1', ownerAi: 'AI-01 세온', reviewers: ['AI-10 아틀라스'], status: 'working' },
  { id: 'TASK-2', ownerAi: 'AI-10 아틀라스', reviewers: [], status: 'review' },
  { id: 'TASK-3', ownerAi: 'AI-05 트렌디', reviewers: [], status: 'working' },
];

const report = buildTeamActivityReport({
  roster,
  tasks,
  selectedTask: { id: 'TASK-1', ownerAi: 'AI-01 세온', claimedAt: '2026-01-01T00:00:00.000Z' },
  pendingApprovalTaskIds: new Set(['TASK-2']),
  readiness: { decision: 'NO_GO', missing: ['R-01'] },
  automation: { triggerInboxPending: 2 },
  workPacket: { packetId: 'PACKET-1' },
  cycleId: 'CYCLE-1',
});

assert.equal(report.truthModel, 'RULE_DRIVEN_AUTOMATION_NOT_CONTINUOUS_LLM_BACKGROUND_THOUGHT');
assert.equal(report.executionSummary.selectedTaskId, 'TASK-1');
assert.equal(report.executionSummary.independentPreparationContinuesWhileApprovalPending, true);
assert.equal(report.executionSummary.pendingApprovalCount, 1);
assert.equal(report.executionSummary.triggerTasksPending, 2);
assert.equal(report.members.find((member) => member.id === 'AI-01').status, 'AUTO_EXECUTING');
assert.equal(report.members.find((member) => member.id === 'AI-10').status, 'WAITING_FOR_H01');
assert.equal(report.members.find((member) => member.id === 'AI-05').status, 'UNVERIFIED_ACTIVE');
assert.deepEqual(report.members.find((member) => member.id === 'AI-05').executionEvidenceTaskIds, []);
assert.equal(report.members.find((member) => member.id === 'H-01').status, 'WAITING_FOR_H01');
assert.ok(report.members.find((member) => member.id === 'AI-10').forbiddenActions.includes('TRADE_FINALIZATION'));
console.log('team activity report: PASS');

