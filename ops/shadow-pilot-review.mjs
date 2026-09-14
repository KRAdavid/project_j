import { readFile } from 'node:fs/promises';

const REQUIRED_SCENARIO_COUNT = 7;

/**
 * Decide whether the latest closed Shadow Pilot is safe to hand to H-01.
 * This function never approves participant access, trading, settlement, or release.
 */
export const evaluateShadowPilotReview = ({ report = null } = {}) => {
  const results = Array.isArray(report?.results) ? report.results : [];
  const preflightChecks = report?.preflight?.checks && typeof report.preflight.checks === 'object'
    ? Object.values(report.preflight.checks)
    : [];
  const invalidLotTradeCount = results.reduce(
    (total, scenario) => total + Number(scenario?.scenario_invalid_lot_trade_count || 0),
    0,
  );
  const checks = {
    decision: report?.decision === 'PASS_REVIEW_REQUIRED',
    scenarioCount: Number(report?.scenario_count) === REQUIRED_SCENARIO_COUNT,
    passedScenarioCount: Number(report?.passed_scenario_count) === REQUIRED_SCENARIO_COUNT,
    allScenariosPassed: results.length === REQUIRED_SCENARIO_COUNT && results.every((scenario) => scenario?.passed === true),
    preflightPassed: report?.preflight?.passed === true && preflightChecks.length > 0 && preflightChecks.every(Boolean),
    closedSimulation: report?.mode === 'CLOSED_SIMULATION',
    realTransactionsDisabled: report?.real_transactions_enabled === false,
    realMoneyDisabled: report?.real_money_enabled === false,
    externalNotificationsDisabled: report?.external_notifications_enabled === false,
    participantAccessDisabled: report?.participant_access_enabled === false,
    invalidLotTradesZero: invalidLotTradeCount === 0,
  };
  const ready = Object.values(checks).every(Boolean);
  return {
    ready,
    checks,
    invalidLotTradeCount,
    evidenceRefs: ready
      ? ['ops/latest-shadow-pilot.json', 'ops/run-shadow-pilot.mjs', 'ops/test-shadow-pilot-integration.mjs']
      : [],
    reason: ready
      ? '폐쇄형 시뮬레이션 증적이 전부 통과하여 H-01 검토 패킷으로 전환 가능'
      : 'Shadow Pilot 증적이 H-01 검토 기준을 모두 충족하지 못함',
  };
};

export const readShadowPilotReview = async (reportPath) => {
  if (!reportPath) throw new Error('Shadow Pilot 보고서 경로가 필요합니다.');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  return { report, ...evaluateShadowPilotReview({ report }) };
};

