import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGitHubTargetPreflight } from './github-target-preflight.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const routing = {
  'R-01': { ownerAi: 'AI-10 아틀라스', reviewers: ['AI-11 실드', 'AI-12 리콘'], nextAction: 'PostgreSQL 연결·마이그레이션·동시 예약·스냅샷 재조정 증거를 스테이징에서 확보한다.' },
  'R-02': { ownerAi: 'AI-11 실드', reviewers: ['AI-10 아틀라스', 'AI-12 리콘'], nextAction: '서명 Bearer 인증과 조직 RBAC 검증 결과를 스테이징에서 확보한다.' },
  'R-04': { ownerAi: 'AI-05 트렌디', reviewers: ['AI-04 원료나', 'AI-09 콘트라'], nextAction: '가격 원천의 권리·품질·표본·승인 참조를 확정한다.' },
  'R-05': { ownerAi: 'AI-12 리콘', reviewers: ['AI-11 실드', 'AI-01 세온'], nextAction: '외부 알림·온콜 연동과 heartbeat 증거를 확보한다.' },
  'R-06': { ownerAi: 'AI-12 리콘', reviewers: ['AI-10 아틀라스', 'AI-11 실드'], nextAction: 'PostgreSQL 백업·복구 리허설 원문과 복구 검증 참조를 확보한다.' },
  'R-07': { ownerAi: 'AI-01 세온', reviewers: ['AI-11 실드', 'AI-13 케어'], nextAction: '검증된 참가자·중단 기준·Shadow Pilot 범위를 H-01이 승인한다.' },
};

const parseOutput = (output = '') => {
  const lines = String(output).trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
};

export const buildCutoverInputManifest = ({ readiness = {}, stagingPreflight = {}, githubTargetPreflight = {}, sourceRunId = null, generatedAt = new Date().toISOString() } = {}) => {
  const safeStagingPreflight = stagingPreflight || {};
  const safeGithubTargetPreflight = githubTargetPreflight || {};
  const diagnostics = new Map((readiness.diagnostics || []).map((item) => [item.id, item]));
  const items = (readiness.checks || []).filter((check) => check.required).map((check) => {
    const route = routing[check.id] || { ownerAi: 'AI-01 세온', reviewers: ['AI-10 아틀라스', 'AI-11 실드'], nextAction: '담당 AI의 증거와 H-01 결정을 확보한다.' };
    const diagnostic = diagnostics.get(check.id) || {};
    return {
      id: check.id,
      name: check.name,
      current: Boolean(check.current),
      status: check.current ? 'READY' : check.id === 'R-07' ? 'HUMAN_APPROVAL_REQUIRED' : 'INPUT_REQUIRED',
      ownerAi: route.ownerAi,
      reviewers: route.reviewers,
      requiredEnvironmentKeys: diagnostic.missing || diagnostic.checkedKeys || [],
      evidenceRef: check.evidence,
      nextAction: route.nextAction,
      humanDecision: check.current ? 'NONE' : 'H-01 must approve or hold before release',
    };
  });
  return {
    schemaVersion: 'CUTOVER-INPUT-MANIFEST-0.1',
    generatedAt,
    sourceRunId,
    humanPrincipal: 'H-01',
    decision: readiness.decision || 'NO_GO',
    items,
    infrastructure: {
      stagingPreflightStatus: safeStagingPreflight.status || 'NOT_AVAILABLE',
      stagingMissingKeys: safeStagingPreflight.missing || [],
      githubTargetStatus: safeGithubTargetPreflight.status || 'NOT_AVAILABLE',
      githubMissingKeys: safeGithubTargetPreflight.missing || [],
      secretValuesRedacted: true,
    },
    guardrail: '이 매니페스트는 입력·증거 수집과 H-01 의사결정을 돕는 자료이며 거래·계약·결제·상용 전환을 실행하지 않는다.',
  };
};

export const writeCutoverInputManifest = async ({ readiness, stagingPreflight = {}, githubTargetPreflight = {}, sourceRunId = null, jsonPath = resolve(root, 'ops', 'latest-cutover-input-manifest.json'), markdownPath = resolve(root, 'ops', 'latest-cutover-input-manifest.md'), generatedAt = new Date().toISOString() } = {}) => {
  const manifest = buildCutoverInputManifest({ readiness, stagingPreflight, githubTargetPreflight, sourceRunId, generatedAt });
  await writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const markdown = [
    `# 상용 전환 입력 매니페스트 · ${manifest.generatedAt}`,
    '',
    `- 판정: **${manifest.decision}**`,
    `- H-01 결정권자: **${manifest.humanPrincipal}**`,
    `- PostgreSQL/Object Storage 사전점검: **${manifest.infrastructure.stagingPreflightStatus}**`,
    `- GitHub 대상 사전점검: **${manifest.infrastructure.githubTargetStatus}**`,
    '',
    '## 조건별 담당·필요 입력',
    ...manifest.items.map((item) => `- **${item.id} ${item.name}** · ${item.status} · 담당 ${item.ownerAi} · 검토 ${item.reviewers.join(', ')} · 필요한 키 ${item.requiredEnvironmentKeys.join(', ') || '없음'} · ${item.nextAction}`),
    '',
    '실제 값과 비밀은 기록하지 않으며, 모든 미충족 조건은 H-01 결정 전까지 상용 운영을 차단한다.',
  ].join('\n');
  await writeFile(markdownPath, `${markdown}\n`, 'utf8');
  return manifest;
};

if (process.argv[1] && basename(process.argv[1]) === 'cutover-input-manifest.mjs') {
  const readJson = async (path, fallback = {}) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
  const autopilot = await readJson(resolve(root, 'ops', 'latest-autopilot-run.json'));
  const readiness = await readJson(resolve(root, 'ops', 'latest-ops-cycle.json'));
  const configuredGitHubTarget = await readJson(resolve(root, 'ops', 'github-target.json'));
  const originResult = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const currentGitHubTarget = buildGitHubTargetPreflight({
    repository: process.env.GITHUB_REPOSITORY || configuredGitHubTarget.repository,
    remote: originResult.status === 0 ? originResult.stdout.trim() : '',
    baseBranch: process.env.GITHUB_BASE_BRANCH || configuredGitHubTarget.baseBranch,
  });
  const result = await writeCutoverInputManifest({
    readiness: await (await import('../beta-app/readiness.mjs')).evaluateReleaseReadiness({ environment: process.env.APP_ENV || 'simulation' }),
    stagingPreflight: parseOutput((autopilot.evidence || []).find((item) => item.name === 'staging-preflight')?.output),
    githubTargetPreflight: currentGitHubTarget,
    sourceRunId: autopilot.runId || readiness.cycleId,
  });
  console.log(JSON.stringify({ decision: result.decision, items: result.items.length, missing: result.items.filter((item) => !item.current).map((item) => item.id) }));
}

