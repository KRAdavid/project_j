import assert from 'node:assert/strict';
import { buildGoalAudit, selectShadowPilotEvidence } from './goal-audit.mjs';

const base = {
  cycle: { cycleId: 'C-001', decision: 'HUMAN_REVIEW_REQUIRED' },
  supervisor: { status: 'RUNNING', daemonReviewRequired: true },
  runtime: { persistenceMode: 'memory', realTradingEnabled: false },
  autopilot: { runId: 'A-001', evidence: [{ passed: true, skipped: false }] },
  browserE2e: { result: 'PASS' },
  patent: { elements: Array.from({ length: 7 }, (_, index) => ({ id: `E${index + 1}` })), patentabilityGuarantee: false },
};

const blocked = buildGoalAudit({
  ...base,
  readiness: { missing: ['R-01', 'R-07'] },
  github: { status: 'BLOCKED', missing: ['TARGET_REPOSITORY'] },
  githubPublication: { status: 'BLOCKED', blockers: ['LOCAL_BRANCH_DIFFERS_FROM_TARGET_BASE'] },
});
assert.equal(blocked.decision, 'NO_GO');
assert.equal(blocked.summary.total, 15);
assert.ok(blocked.summary.blocked >= 3);
assert.equal(blocked.runtime.realTradingEnabled, false);
assert.ok(blocked.checks.some((item) => item.id === 'BM_PATENT_PREPARATION' && item.status === 'PREPARED'));

const review = buildGoalAudit({
  ...base,
  readiness: { missing: [] },
  github: { status: 'TARGET_MATCH', missing: [] },
  githubPublication: { status: 'READY_FOR_EXPLICIT_PUSH', blockers: [] },
});
assert.equal(review.decision, 'REVIEW_REQUIRED');
assert.equal(review.summary.blocked, 0);
assert.equal(review.summary.verified, 13);

const shadowPilot = {
  decision: 'PASS_REVIEW_REQUIRED',
  scenario_count: 7,
  passed_scenario_count: 7,
  real_transactions_enabled: false,
  real_money_enabled: false,
  participant_access_enabled: false,
  preflight: { passed: true },
  scenarioSummary: {
    invalidLotTradeCount: 0,
    scenarios: Array.from({ length: 7 }, () => ({ passed: true })),
  },
};
const reviewedShadowPilot = buildGoalAudit({
  ...base,
  readiness: { missing: ['R-01'] },
  github: { status: 'TARGET_MATCH', targetRepository: 'KRAdavid/project_j', baseBranch: 'main' },
  githubPublication: { status: 'BLOCKED', blockers: [] },
  shadowPilot,
});
assert.equal(reviewedShadowPilot.checks.find((item) => item.id === 'SHADOW_PILOT_EXECUTION').status, 'VERIFIED');

const latestShadowPilot = buildGoalAudit({
  ...base,
  readiness: { missing: ['R-01'] },
  github: { status: 'TARGET_MATCH', targetRepository: 'KRAdavid/project_j', baseBranch: 'main' },
  githubPublication: { status: 'BLOCKED', blockers: [] },
  shadowPilot: {
    schema_version: 'SHADOW-PILOT-RUN-0.2',
    decision: 'PASS_REVIEW_REQUIRED',
    scenario_count: 7,
    passed_scenario_count: 7,
    real_transactions_enabled: false,
    real_money_enabled: false,
    participant_access_enabled: false,
    preflight: { passed: true },
    results: Array.from({ length: 7 }, () => ({ passed: true, scenario_invalid_lot_trade_count: 0 })),
  },
});
assert.equal(latestShadowPilot.checks.find((item) => item.id === 'SHADOW_PILOT_EXECUTION').status, 'VERIFIED');
const latestEvidence = { decision: 'PASS_REVIEW_REQUIRED', preflight: { passed: false } };
assert.equal(selectShadowPilotEvidence({ latest: latestEvidence, baseline: shadowPilot }), latestEvidence);
assert.equal(selectShadowPilotEvidence({ latest: null, baseline: shadowPilot }), shadowPilot);

const published = buildGoalAudit({
  ...base,
  readiness: { missing: ['R-01'] },
  github: { status: 'TARGET_MATCH', targetRepository: 'KRAdavid/project_j', baseBranch: 'main' },
  githubPublication: { status: 'BLOCKED', blockers: ['LOCAL_BRANCH_DIFFERS_FROM_TARGET_BASE'] },
  githubPublicationVerification: {
    status: 'PUBLISHED',
    repository: 'KRAdavid/project_j',
    baseBranch: 'main',
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    ciHeadSha: '0123456789abcdef0123456789abcdef01234567',
    ciConclusion: 'success',
    sourceUrl: 'https://github.com/KRAdavid/project_j/commit/0123456789abcdef0123456789abcdef01234567',
    ciRunUrl: 'https://github.com/KRAdavid/project_j/actions/runs/1',
  },
});
assert.equal(published.checks.find((item) => item.id === 'GITHUB_PUBLICATION').status, 'VERIFIED');
assert.equal(published.runtime.githubPublicationStatus, 'PUBLISHED');

const publishedWithPremergeCi = buildGoalAudit({
  ...base,
  readiness: { missing: ['R-01'] },
  github: { status: 'TARGET_MATCH', targetRepository: 'KRAdavid/project_j', baseBranch: 'main' },
  githubPublication: { status: 'BLOCKED', blockers: ['LOCAL_BRANCH_DIFFERS_FROM_TARGET_BASE'] },
  githubPublicationVerification: {
    status: 'PUBLISHED',
    repository: 'KRAdavid/project_j',
    baseBranch: 'main',
    commitSha: 'fedcba9876543210fedcba9876543210fedcba98',
    ciHeadSha: '0123456789abcdef0123456789abcdef01234567',
    ciConclusion: 'success',
    verificationMode: 'REMOTE_MAIN_VERIFIED_WITH_PREMERGE_CI',
    remoteMainCommitVerified: true,
    sourceUrl: 'https://github.com/KRAdavid/project_j/commit/fedcba9876543210fedcba9876543210fedcba98',
    ciRunUrl: 'https://github.com/KRAdavid/project_j/actions/runs/2',
  },
});
assert.equal(publishedWithPremergeCi.checks.find((item) => item.id === 'GITHUB_PUBLICATION').status, 'VERIFIED');
assert.equal(publishedWithPremergeCi.runtime.githubPublicationStatus, 'PUBLISHED');
console.log('goal audit contract: PASS');

