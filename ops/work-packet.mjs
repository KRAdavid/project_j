import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evidenceFingerprint } from './autopilot-selection.mjs';

const forbiddenActions = [
  'APPROVE_TRADE',
  'APPROVE_CONTRACT',
  'RELEASE_PAYMENT',
  'CLOSE_DISPUTE',
  'PRODUCTION_CUTOVER',
];

export const buildWorkPacket = ({ run, generatedAt = run?.generatedAt || new Date().toISOString() } = {}) => {
  const task = run?.selectedTask || null;
  const evidence = Array.isArray(run?.evidence) ? run.evidence : [];
  const failed = evidence.filter((item) => !item.passed && !item.skipped);
  const skipped = evidence.filter((item) => item.skipped);
  if (!task) {
    return {
      schemaVersion: 'AI-WORK-PACKET-0.1',
      packetId: `WORK-PACKET-${run?.runId || 'NO-RUN'}`,
      runId: run?.runId || null,
      generatedAt,
      status: 'NO_TASK',
      evidenceFingerprint: evidenceFingerprint(evidence),
      humanGate: 'approval',
      allowedActions: ['ANALYZE', 'RUN_TESTS', 'WRITE_REVIEW_PACKET'],
      forbiddenActions,
      evidenceSummary: { total: evidence.length, passed: evidence.filter((item) => item.passed).length, failed: failed.length, skipped: skipped.length },
    };
  }
  const status = failed.length ? 'BLOCKED' : skipped.length ? 'EVIDENCE_GAP' : 'READY_FOR_REVIEW';
  return {
    schemaVersion: 'AI-WORK-PACKET-0.1',
    packetId: `WORK-PACKET-${run.runId}-${task.id}`,
    runId: run.runId,
    generatedAt,
    status,
    taskId: task.id,
    objective: task.objective,
    ownerAi: task.ownerAi,
    reviewers: task.reviewers,
    risk: task.risk,
    humanGate: 'approval',
    allowedActions: ['ANALYZE', 'RUN_TESTS', 'WRITE_REVIEW_PACKET'],
    forbiddenActions,
    evidenceSummary: { total: evidence.length, passed: evidence.filter((item) => item.passed).length, failed: failed.length, skipped: skipped.length },
    evidenceFingerprint: evidenceFingerprint(evidence),
    evidenceRefs: evidence.map((item) => ({ name: item.name, passed: Boolean(item.passed), skipped: Boolean(item.skipped) })),
    nextAction: task.nextAction || '담당 AI가 증거를 검토하고 H-01 결정 패킷을 준비한다.',
    decision: run.decision,
    guardrail: 'AI 작업 패킷은 분석·검증·준비만 허용하며 실제 거래·계약·결제·분쟁 종결·상용 전환을 수행하지 않는다.',
  };
};

export const appendWorkPacket = async (packetsPath, packet) => {
  if (!packetsPath) throw new Error('AI 작업 패킷 저장 경로가 필요합니다.');
  await mkdir(dirname(packetsPath), { recursive: true });
  await appendFile(packetsPath, `${JSON.stringify(packet)}\n`, 'utf8');
  return packet;
};

export { forbiddenActions };

