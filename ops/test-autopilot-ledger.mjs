import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAutopilotRun, buildApprovalInbox, readAutopilotHistory, writeApprovalInbox } from './autopilot-ledger.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-autopilot-'));
try {
  const historyPath = join(tempRoot, 'audit', 'autopilot-history.jsonl');
  const inboxPath = join(tempRoot, 'approval-inbox.json');
  const run = {
    runId: 'AUTOPILOT-TEST-001',
    generatedAt: '2026-09-08T00:00:00.000Z',
    decision: 'HUMAN_REVIEW_REQUIRED',
    selectionType: 'working-follow-up',
    selectedTask: { id: 'TASK-TEST-001', objective: '테스트 업무', risk: 'critical', reviewers: ['AI-11 실드'] },
    evidence: [
      { name: 'pass', passed: true, skipped: false, command: 'node test-pass.mjs' },
      { name: 'postgres', passed: true, skipped: true, output: 'SKIP (DATABASE_URL not provided)', command: 'node test-postgres.mjs' },
    ],
    authority: { canApproveTrade: false, canReleasePayment: false },
    automation: {
      triggerTasks: [{ id: 'AUTO-TEST-001', triggerKey: 'READINESS_NO_GO', objective: '릴리스 조건 검토', risk: 'critical', reviewers: ['AI-10 아틀라스'] }],
    },
  };

  await appendAutopilotRun(historyPath, run);
  await appendAutopilotRun(historyPath, { ...run, runId: 'AUTOPILOT-TEST-002' });
  const history = await readAutopilotHistory(historyPath);
  if (history.length !== 2 || history[0].selectedTaskId !== 'TASK-TEST-001' || !history[0].evidence[1].skipped) throw new Error('자동운영 이력 누적 검증 실패');

  const inbox = buildApprovalInbox(run);
  if (inbox.status !== 'PENDING' || inbox.items.length !== 2 || inbox.items[0].requiredPrincipal !== 'H-01' || inbox.unresolvedEvidence.length !== 1) throw new Error('승인 대기열 생성 검증 실패');
  const duplicateRun = {
    ...run,
    selectedTask: { id: 'TASK-DUPLICATE', objective: '선택 업무', risk: 'critical', reviewers: ['AI-11 실드'] },
    automation: { triggerTasks: [{ id: 'TASK-DUPLICATE', triggerKey: 'QUALITY_GATE_FAILED', objective: '동일 업무 트리거', risk: 'critical', reviewers: ['AI-12 리콘'] }, { id: 'TASK-UNIQUE', triggerKey: 'READINESS_NO_GO', objective: '별도 업무', risk: 'critical', reviewers: ['AI-10 아틀라스'] }] },
  };
  const deduplicated = buildApprovalInbox(duplicateRun);
  if (deduplicated.items.length !== 2 || deduplicated.items.filter((item) => item.taskId === 'TASK-DUPLICATE').length !== 1 || deduplicated.items[0].approvalId !== 'APPROVAL-AUTOPILOT-TEST-001') throw new Error('동일 taskId 승인 항목 중복 제거 검증 실패');
  await writeApprovalInbox(inboxPath, run);
  const savedInbox = JSON.parse(await readFile(inboxPath, 'utf8'));
  if (savedInbox.items[0].approvalId !== 'APPROVAL-AUTOPILOT-TEST-001') throw new Error('승인 대기열 저장 검증 실패');
  const decidedRun = { ...run, runId: 'AUTOPILOT-TEST-002', automation: run.automation };
  savedInbox.items[0].status = 'HELD';
  await writeFile(inboxPath, `${JSON.stringify(savedInbox)}\n`);
  await writeApprovalInbox(inboxPath, { ...decidedRun, selectedTask: { ...decidedRun.selectedTask, id: 'TASK-TEST-001' } });
  const preserved = JSON.parse(await readFile(inboxPath, 'utf8'));
  const refreshed = preserved.items.find((item) => item.taskId === 'TASK-TEST-001');
  if (refreshed.status !== 'PENDING' || refreshed.supersedesApprovalId !== 'APPROVAL-AUTOPILOT-TEST-001' || refreshed.supersededStatus !== 'HELD') throw new Error('새 검토 패킷이 기존 인간 승인 상태를 잘못 승계함');
  console.log('autopilot ledger tests: PASS');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

