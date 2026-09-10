import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGitHubPublicationPreflight } from './github-publication-preflight.mjs';
import { buildGitHubTargetPreflight } from './github-target-preflight.mjs';
import { evaluateReleaseReadiness } from '../beta-app/readiness.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const opsRoot = resolve(root, 'ops');

const readJson = async (path, fallback = null) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};

const gitOrigin = () => {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : '';
};

const check = (id, area, label, status, evidence, note = '') => ({ id, area, label, status, evidence, note });

export const buildGoalAudit = ({ cycle = {}, readiness = {}, github = {}, githubPublication = {}, githubPublicationVerification = {}, supervisor = {}, runtime = {}, autopilot = {}, browserE2e = {}, patent = {} } = {}) => {
  const evidenceFailed = Number(autopilot.evidence?.filter?.((item) => !item.passed && !item.skipped).length || 0);
  const e2ePassed = browserE2e.result === 'PASS';
  const patentPrepared = Array.isArray(patent.elements) && patent.elements.length >= 7 && patent.patentabilityGuarantee === false;
  const readinessMissing = Array.isArray(readiness.missing) ? readiness.missing : [];
  const supervisorRunning = ['STARTING', 'RUNNING', 'DEGRADED'].includes(supervisor.status);
  const publicationCommit = String(githubPublicationVerification.commitSha || '');
  const publicationVerified = github.status === 'TARGET_MATCH'
    && githubPublicationVerification.status === 'PUBLISHED'
    && String(githubPublicationVerification.repository || '').toLowerCase() === String(github.targetRepository || '').toLowerCase()
    && String(githubPublicationVerification.baseBranch || '') === String(github.baseBranch || '')
    && /^[0-9a-f]{40}$/i.test(publicationCommit)
    && String(githubPublicationVerification.ciHeadSha || '').toLowerCase() === publicationCommit.toLowerCase()
    && String(githubPublicationVerification.ciConclusion || '').toLowerCase() === 'success'
    && /^https:\/\/github\.com\//i.test(String(githubPublicationVerification.sourceUrl || ''))
    && /^https:\/\/github\.com\//i.test(String(githubPublicationVerification.ciRunUrl || ''));
  const checks = [
    check('PRODUCT_PHYSICAL_TRADE', 'product', 'GABA 실물 원료 거래 생명주기', e2ePassed ? 'VERIFIED' : 'NOT_VERIFIED', ['ops/latest-browser-e2e.json', 'beta-app/test-market-board-lifecycle.mjs'], e2ePassed ? '스펙 확정·주문·체결·납품·검수 완료 확인' : '브라우저 E2E 증거가 없음'),
    check('PRODUCT_PRETRADE_GATE', 'product', '거래 전 스펙·증빙·로트·재고 게이트', evidenceFailed === 0 ? 'VERIFIED' : 'NOT_VERIFIED', ['beta-app/test-evidence-verifier.mjs', 'beta-app/test-supplier-verification-gate.mjs', 'beta-app/test-lot-onboarding.mjs']),
    check('PRODUCT_REALTIME', 'product', 'SSE 실시간 거래 화면과 역할 분리', evidenceFailed === 0 ? 'VERIFIED' : 'NOT_VERIFIED', ['beta-app/test-sse-integration.mjs', 'beta-app/test-sse-heartbeat.mjs', 'ops/validate-ui-contract.mjs']),
    check('AUTOMATED_TF', 'operations', 'AI TF 업무 큐·SLA·승인 패킷 자동화', autopilot.runId ? 'VERIFIED' : 'NOT_VERIFIED', ['ops/latest-autopilot-run.json', 'ops/work-packets.jsonl', 'data/team-roster.json']),
    check('SUPERVISED_RUNTIME', 'operations', '회사형 감독자·데몬 생존 감시', supervisorRunning ? 'VERIFIED' : 'NOT_VERIFIED', ['ops/company-supervisor-status.json', 'ops/daemon-status.json'], supervisor.daemonReviewRequired ? '프로세스는 살아 있으나 마지막 사이클은 H-01 검토 대기' : ''),
    check('GITHUB_TARGET', 'delivery', 'GitHub 저장소·origin·기준 브랜치 일치', github.status === 'TARGET_MATCH' ? 'VERIFIED' : 'BLOCKED', ['ops/github-target-preflight.mjs', 'ops/configure-github-target.ps1'], github.missing?.join(', ') || ''),
    check('GITHUB_PUBLICATION', 'delivery', 'GitHub 공개 반영', publicationVerified || githubPublication.status === 'READY_FOR_EXPLICIT_PUSH' ? 'VERIFIED' : 'BLOCKED', publicationVerified ? ['ops/latest-github-publication-verification.json', 'GitHub main commit', 'GitHub Actions CI'] : ['ops/github-publication-preflight.mjs', 'ops/latest-github-publication-preflight.json'], publicationVerified ? `원격 ${githubPublicationVerification.baseBranch} 커밋·CI 확인` : githubPublication.blockers?.join(', ') || '명시적 푸시 승인 및 브랜치 전략 필요'),
    check('PRODUCTION_PERSISTENCE', 'infrastructure', 'PostgreSQL 영속 원장·원자 예약·재조정 증거', readinessMissing.includes('R-01') ? 'BLOCKED' : 'VERIFIED', ['data/postgres-schema.sql', 'ops/release-readiness.json'], readinessMissing.includes('R-01') ? '실 PostgreSQL 증거 미확보' : ''),
    check('ORGANIZATION_AUTH', 'infrastructure', '기업 인증·RBAC 운영 증거', readinessMissing.includes('R-02') ? 'BLOCKED' : 'VERIFIED', ['data/authorization-policy.json', 'ops/release-readiness.json'], readinessMissing.includes('R-02') ? '운영 인증 제공자 증거 미확보' : ''),
    check('PRICE_SOURCE_APPROVAL', 'infrastructure', '가격원천·공개 승인', readinessMissing.includes('R-04') ? 'BLOCKED' : 'VERIFIED', ['data/price-source-contract.json', 'beta-app/price-feed.mjs'], readinessMissing.includes('R-04') ? '가격원천 승인 참조 미확보' : ''),
    check('MONITORING_ALERTING', 'infrastructure', '외부 모니터링·알림·감독자 heartbeat', readinessMissing.includes('R-05') ? 'BLOCKED' : 'VERIFIED', ['ops/monitor-beta.mjs', 'ops/incident-ledger.mjs', 'ops/notification-outbox.mjs'], readinessMissing.includes('R-05') ? '외부 연결·heartbeat 증거 미확보' : ''),
    check('BACKUP_RESTORE', 'infrastructure', '백업·복구 리허설', readinessMissing.includes('R-06') ? 'BLOCKED' : 'VERIFIED', ['ops/postgres-backup-restore-drill.mjs'], readinessMissing.includes('R-06') ? '실 DB 복구 원문 미확보' : ''),
    check('SHADOW_PILOT_APPROVAL', 'operations', '폐쇄형 Shadow Pilot H-01 승인', readinessMissing.includes('R-07') ? 'BLOCKED' : 'VERIFIED', ['ops/shadow-pilot-plan.json', 'ops/release-readiness.json'], readinessMissing.includes('R-07') ? 'H-01 승인 미확보' : ''),
    check('BM_PATENT_PREPARATION', 'patent', 'BM특허 발명 설명·구성요소·선행기술 추적', patentPrepared ? 'PREPARED' : 'NOT_VERIFIED', ['data/patent-claim-traceability.json', 'data/patent-prior-art.json', 'ops/patent-claim-outline.mjs'], patentPrepared ? '변리사 검토용이며 등록성 보장 아님' : '특허 추적성 자료가 불완전함'),
  ];
  const blocked = checks.filter((item) => item.status === 'BLOCKED');
  return {
    schemaVersion: 'GOAL-AUDIT-0.1',
    generatedAt: new Date().toISOString(),
    objective: 'GitHub 연계·BM특허 고려·회사형 자동운영을 갖춘 실물 원료 구매 거래 플랫폼',
    decision: blocked.length ? 'NO_GO' : 'REVIEW_REQUIRED',
    summary: { total: checks.length, verified: checks.filter((item) => item.status === 'VERIFIED').length, prepared: checks.filter((item) => item.status === 'PREPARED').length, blocked: blocked.length, notVerified: checks.filter((item) => item.status === 'NOT_VERIFIED').length },
    runtime: { cycleId: cycle.cycleId || null, cycleDecision: cycle.decision || null, supervisorStatus: supervisor.status || null, persistenceMode: runtime.persistenceMode || null, realTradingEnabled: runtime.realTradingEnabled === true, githubStatus: github.status || 'UNKNOWN', githubPublicationStatus: githubPublication.status || 'UNKNOWN' },
    checks,
    nextActions: blocked.map((item) => ({ id: item.id, action: item.note || `${item.label} 증거를 확보한다.`, evidence: item.evidence })),
    guardrail: '이 감사는 상태·증거를 집계할 뿐이며 AI가 거래·계약·결제·특허출원·GitHub 외부 쓰기를 승인하지 않는다.',
  };
};

export const writeGoalAudit = async ({ jsonPath = resolve(opsRoot, 'latest-goal-audit.json'), markdownPath = resolve(opsRoot, 'latest-goal-audit.md'), generatedAt = new Date().toISOString() } = {}) => {
  const cycle = await readJson(resolve(opsRoot, 'latest-ops-cycle.json'), {});
  const configuredReadiness = await readJson(resolve(opsRoot, 'release-readiness.json'), {});
  const readiness = Array.isArray(cycle.readiness?.missing) ? { ...configuredReadiness, ...cycle.readiness } : configuredReadiness;
  const githubTarget = await readJson(resolve(opsRoot, 'github-target.json'), {});
  const github = buildGitHubTargetPreflight({ repository: process.env.GITHUB_REPOSITORY || githubTarget.repository, remote: gitOrigin(), baseBranch: process.env.GITHUB_BASE_BRANCH || githubTarget.baseBranch });
  const githubPublication = await buildGitHubPublicationPreflight({ target: githubTarget });
  const githubPublicationVerification = await readJson(resolve(opsRoot, 'latest-github-publication-verification.json'), {});
  const audit = buildGoalAudit({
    cycle,
    readiness,
    github,
    githubPublication,
    githubPublicationVerification,
    supervisor: await readJson(resolve(opsRoot, 'company-supervisor-status.json'), {}),
    runtime: await readJson(resolve(opsRoot, 'company-mode-runtime.json'), {}),
    autopilot: await readJson(resolve(opsRoot, 'latest-autopilot-run.json'), {}),
    browserE2e: await readJson(resolve(opsRoot, 'latest-browser-e2e.json'), {}),
    patent: await readJson(resolve(root, 'data', 'patent-claim-traceability.json'), {}),
  });
  audit.generatedAt = generatedAt;
  await writeFile(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  const markdown = [
    `# 최종 목표 감사 · ${audit.generatedAt}`,
    '',
    `- 판정: **${audit.decision}**`,
    `- 요약: 전체 ${audit.summary.total}건 · 검증 ${audit.summary.verified}건 · 준비 ${audit.summary.prepared}건 · 차단 ${audit.summary.blocked}건 · 미검증 ${audit.summary.notVerified}건`,
    '',
    '## 요구사항별 판정',
    ...audit.checks.map((item) => `- **${item.status}** · ${item.id} · ${item.label} · ${item.evidence.join(', ')}${item.note ? ` · ${item.note}` : ''}`),
    '',
    '## 다음 조치',
    ...(audit.nextActions.length ? audit.nextActions.map((item) => `- **${item.id}** · ${item.action}`) : ['- 차단 조치 없음']),
    '',
    audit.guardrail,
  ].join('\n');
  await writeFile(markdownPath, `${markdown}\n`, 'utf8');
  return audit;
};

if (process.argv[1] && basename(process.argv[1]) === 'goal-audit.mjs') {
  const audit = await writeGoalAudit();
  console.log(JSON.stringify({ decision: audit.decision, summary: audit.summary, github: audit.runtime.githubStatus }));
}

