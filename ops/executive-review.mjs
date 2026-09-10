import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateApprovalSla } from './approval-sla.mjs';
import { buildGitHubTargetPreflight } from './github-target-preflight.mjs';
import { evaluateTaskSla } from './task-sla.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const parseJsonOutput = (output = '') => {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
};

const missingAction = {
  'R-01': 'PostgreSQL 연결·스키마 적용·정규 도메인 API·재조정 증거를 스테이징에서 확보',
  'R-02': '서명 Bearer 토큰 기반 인증 제공자와 조직 RBAC 운영 증거를 확보',
  'R-04': '가격 원천 권리·품질·표본·공개 승인 참조를 확정',
  'R-05': '외부 알림/온콜 연동과 heartbeat 확인 증거를 확보',
  'R-06': 'PostgreSQL 백업·복구 리허설 원문과 증거 참조를 확보',
  'R-07': '폐쇄형 Shadow Pilot 범위·참가자·중단기준에 대한 H-01 승인 확보',
};

const approvalGuidance = (item = {}) => {
  const triggerKey = String(item.triggerKey || '');
  if (triggerKey === 'QUALITY_GATE_FAILED' || triggerKey === 'TASK_METADATA_GAP') {
    return { recommendation: 'APPROVE_AI_REMEDIATION_ONLY', reason: 'AI가 원인·정정안을 조사할 수 있지만 거래·계약·결제·운영 재개는 허용하지 않음' };
  }
  return { recommendation: 'HOLD_REAL_OPERATIONS', reason: '외부 증거 또는 릴리스 조건이 충족되기 전까지 실거래·계약·결제를 보류' };
};

export const buildExecutiveReview = ({ cycle = {}, autopilot = {}, readiness = {}, approvalInbox = {}, taskQueue = {}, taskTimelineAudit = cycle.automation?.taskTimelineAudit || {}, taskAuditRemediation = cycle.automation?.taskAuditRemediation || {}, githubTargetPreflight = null, generatedAt = new Date().toISOString() } = {}) => {
  const evidence = Array.isArray(autopilot.evidence) ? autopilot.evidence : [];
  const staging = parseJsonOutput(evidence.find((item) => item.name === 'staging-preflight')?.output);
  const github = githubTargetPreflight || parseJsonOutput(evidence.find((item) => item.name === 'github-target-preflight')?.output);
  const failed = evidence.filter((item) => !item.passed && !item.skipped).map((item) => ({ name: item.name, output: item.output || '' }));
  const skipped = evidence.filter((item) => item.skipped).map((item) => ({ name: item.name, output: item.output || '' }));
  const missing = Array.isArray(readiness.missing) ? readiness.missing : [];
  const pendingApprovals = (Array.isArray(approvalInbox.items) ? approvalInbox.items : [])
    .filter((item) => item.status === 'PENDING')
    .map((item) => ({
      approvalId: item.approvalId || null,
      taskId: item.taskId || null,
      triggerKey: item.triggerKey || null,
      objective: item.objective || null,
      risk: item.risk || null,
      reviewers: item.reviewers || [],
      humanPrincipal: item.requiredPrincipal || 'H-01',
      ...approvalGuidance(item),
      externalSideEffect: false,
    }));
  return {
    schemaVersion: 'EXECUTIVE-REVIEW-0.1',
    generatedAt,
    humanPrincipal: 'H-01',
    decision: readiness.decision === 'GO' && cycle.monitor?.status === 'OK' && autopilot.decision === 'HUMAN_REVIEW_REQUIRED' ? 'REVIEW_REQUIRED' : 'HOLD',
    recommendation: 'HOLD_REAL_OPERATIONS',
    cycle: { cycleId: cycle.cycleId || null, monitor: cycle.monitor?.status || 'UNKNOWN', selectedTaskId: cycle.autopilot?.taskId || autopilot.selectedTask?.id || null },
    notifications: {
      delivery: cycle.automation?.notificationOutbox?.dispatch?.status || cycle.automation?.notificationOutbox?.delivery || 'OUTBOX_ONLY',
      externalNotificationSent: cycle.automation?.notificationOutbox?.dispatch?.externalNotificationSent === true,
      incidentEscalation: cycle.automation?.notificationOutbox?.dispatch?.incidentEscalation === true,
    },
    readiness: { decision: readiness.decision || cycle.readiness?.decision || 'UNKNOWN', missing, requiredActions: missing.map((id) => ({ id, action: missingAction[id] || '담당 AI의 증거와 H-01 결정을 확보' })) },
    evidence: { total: evidence.length, passed: evidence.filter((item) => item.passed).length, skipped, failed },
    stagingPreflight: staging ? { status: staging.status, missing: staging.missing || [], secretValuesRedacted: staging.secretValuesRedacted === true } : { status: 'NOT_AVAILABLE' },
    githubTargetPreflight: github ? { status: github.status, missing: github.missing || [], secretValuesRedacted: github.secretValuesRedacted === true } : { status: 'NOT_AVAILABLE' },
    approvals: {
      status: approvalInbox.status || 'UNKNOWN',
      pending: Array.isArray(approvalInbox.items) ? approvalInbox.items.filter((item) => item.status === 'PENDING').length : 0,
      humanPrincipal: 'H-01',
      sla: evaluateApprovalSla({ items: approvalInbox.items, now: generatedAt }),
      decisionGuide: pendingApprovals,
    },
    tasks: {
      sla: evaluateTaskSla({ tasks: taskQueue.tasks, now: generatedAt }),
    },
    taskAudit: {
      status: taskTimelineAudit.status || 'NOT_REPORTED',
      activeViolationCount: Number(taskTimelineAudit.activeViolationCount || 0),
      archiveViolationCount: Number(taskTimelineAudit.archiveViolationCount || 0),
      remainingArchiveViolationCount: Number(taskTimelineAudit.remainingArchiveViolationCount || 0),
      remediationStatus: taskAuditRemediation.status || 'NOT_REPORTED',
      remediationPlanId: taskAuditRemediation.planId || null,
      requiredApprovalId: taskAuditRemediation.requiredApprovalId || null,
      actionCount: Number(taskAuditRemediation.actionCount || 0),
      eligibleActionCount: Number(taskAuditRemediation.eligibleActionCount || 0),
      appliedTaskIds: taskAuditRemediation.appliedTaskIds || [],
    },
    options: [
      { id: 'HOLD_REAL_OPERATIONS', label: '실거래·계약·결제·참가자 접근 보류', recommended: true },
      { id: 'APPROVE_AI_REMEDIATION_ONLY', label: 'AI 분석·테스트·복구 준비만 승인', recommended: false },
      { id: 'APPROVE_SHADOW_PILOT', label: '별도 Shadow Pilot 승인 검토', recommended: false, prerequisite: 'R-07 및 모든 중단기준 확인' },
    ],
    patentAndLegal: { status: 'EXTERNAL_REVIEW_REQUIRED', actions: ['공식 선행기술 조사', '변리사 청구항 검토', '대상 국가별 법무·규제 검토'] },
    guardrail: '이 패킷은 의사결정 자료이며 H-01 승인·거래·계약·결제·상용 전환을 자동 실행하지 않는다.',
  };
};

export const writeExecutiveReview = async ({ cyclePath = resolve(root, 'ops', 'latest-ops-cycle.json'), autopilotPath = resolve(root, 'ops', 'latest-autopilot-run.json'), readinessPath = resolve(root, 'ops', 'release-readiness.json'), approvalPath = resolve(root, 'ops', 'approval-inbox.json'), queuePath = resolve(root, 'ops', 'task-queue.json'), jsonPath = resolve(root, 'ops', 'latest-executive-review.json'), markdownPath = resolve(root, 'ops', 'latest-executive-review.md'), generatedAt = new Date().toISOString() } = {}) => {
  const readJson = async (path, fallback = {}) => {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  };
  const cycle = await readJson(cyclePath);
  const autopilot = await readJson(autopilotPath);
  const configuredReadiness = await readJson(readinessPath);
  // release-readiness.json is the static policy; the latest cycle contains
  // the evaluated GO/NO_GO result and exact missing IDs. Prefer the evaluated
  // values when available so a standalone report cannot show false clearance.
  const readiness = Array.isArray(cycle.readiness?.missing)
    ? { ...configuredReadiness, ...cycle.readiness }
    : configuredReadiness;
  const approvalInbox = await readJson(approvalPath);
  const taskQueue = await readJson(queuePath, { tasks: [] });
  const configuredGitHubTarget = await readJson(resolve(root, 'ops', 'github-target.json'));
  const originResult = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const githubTargetPreflight = buildGitHubTargetPreflight({
    repository: process.env.GITHUB_REPOSITORY || configuredGitHubTarget.repository,
    remote: originResult.status === 0 ? originResult.stdout.trim() : '',
    baseBranch: process.env.GITHUB_BASE_BRANCH || configuredGitHubTarget.baseBranch,
  });
  const review = buildExecutiveReview({ cycle, autopilot, readiness, approvalInbox, taskQueue, taskTimelineAudit: cycle.automation?.taskTimelineAudit, taskAuditRemediation: cycle.automation?.taskAuditRemediation, githubTargetPreflight, generatedAt });
  await writeFile(jsonPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  const markdown = [
    `# 경영진 검토 패킷 · ${review.generatedAt}`,
    '',
    `- 결정: **${review.decision}**`,
    `- 권고: **${review.recommendation}**`,
    `- 모니터링: **${review.cycle.monitor}**`,
    `- 상용 전환: **${review.readiness.decision}**`,
    `- H-01 승인 대기: **${review.approvals.pending}건**`,
    `- 승인 SLA 초과: **${review.approvals.sla.staleCount}건** (외부 알림 미발송)`,
    `- 업무 SLA 초과: **${review.tasks.sla.staleCount}건** (담당 변경·실행 재개 자동 처리 없음)`,
    `- 외부 알림 전달: **${review.notifications.delivery}**${review.notifications.incidentEscalation ? ' · 운영 사고 승격' : ''}`,
    `- 업무 감사: **${review.taskAudit.status}** · 활성 위반 ${review.taskAudit.activeViolationCount}건 · 아카이브 잔여 위반 ${review.taskAudit.remainingArchiveViolationCount}건`,
    `- 감사 정정: **${review.taskAudit.remediationStatus}** · 적용 가능 ${review.taskAudit.eligibleActionCount}건 · 계획 ${review.taskAudit.remediationPlanId || '없음'}`,
    '',
    '## 즉시 결론',
    '- 실거래·계약·결제·참가자 접근은 H-01 승인과 모든 필수 릴리스 조건 충족 전까지 보류한다.',
    '',
    '## 미충족 조건',
    ...(review.readiness.requiredActions.length ? review.readiness.requiredActions.map((item) => `- **${item.id}** · ${item.action}`) : ['- 없음']),
    '',
    '## 증거 요약',
    `- 전체 ${review.evidence.total}건 · 통과 ${review.evidence.passed}건 · 보류성 SKIP ${review.evidence.skipped.length}건 · 실패 ${review.evidence.failed.length}건`,
    `- PostgreSQL/Object Storage 사전점검: **${review.stagingPreflight.status}**`,
    `- GitHub 대상 사전점검: **${review.githubTargetPreflight.status}**`,
    '',
    '## H-01 선택지',
    ...review.options.map((option) => `- ${option.recommended ? '**권고** ' : ''}${option.id}: ${option.label}${option.prerequisite ? ` (${option.prerequisite})` : ''}`),
    '',
    '이 문서는 AI가 분석·정리한 검토 자료이며 승인·거래·계약·결제·상용 전환을 자동 실행하지 않는다.',
  ].join('\n');
  await writeFile(markdownPath, `${markdown}\n`, 'utf8');
  return review;
};

if (process.argv[1] && basename(process.argv[1]) === 'executive-review.mjs') {
  const review = await writeExecutiveReview();
  console.log(JSON.stringify({ decision: review.decision, recommendation: review.recommendation, missing: review.readiness.missing, pendingApprovals: review.approvals.pending }));
}

