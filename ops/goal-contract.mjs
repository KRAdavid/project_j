import { createHash } from 'node:crypto';

export const GOAL_STATUSES = Object.freeze([
  'INTAKE', 'NORMALIZED', 'CHALLENGED', 'PLANNED', 'COMMITTED', 'RUNNING',
  'VERIFYING', 'OBSERVING', 'ADAPTING', 'SUCCEEDED', 'BLOCKED', 'CONFLICTED',
  'PAUSED', 'CLOSED',
]);

const asArray = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
const asText = (value, fallback = '') => String(value ?? fallback).trim();
const stableId = (text) => `GL-${createHash('sha256').update(text).digest('hex').slice(0, 12).toUpperCase()}`;

export const buildGoalId = (intent) => stableId(asText(intent));

export const validateGoalContract = (contract) => {
  const errors = [];
  const required = [
    'goalId', 'tenantId', 'owner', 'intentOriginal', 'outcomeNormalized',
    'goalArchetypes', 'definitionOfDone', 'scopeIn', 'scopeOut', 'constraints',
    'invariants', 'assumptions', 'dependencies', 'humanDependencies',
    'externalUncertainties', 'budget', 'authorityProfile', 'dataClassification',
    'environment', 'deadline', 'priority', 'preemptionPolicy', 'stopConditions',
    'reportingPolicy', 'domainPackVersions', 'policySnapshot', 'status',
  ];
  for (const key of required) if (contract?.[key] === undefined || contract?.[key] === null) errors.push(`required:${key}`);
  if (!GOAL_STATUSES.includes(contract?.status)) errors.push('status:INVALID');
  if (!Array.isArray(contract?.goalArchetypes) || contract.goalArchetypes.length === 0) errors.push('goalArchetypes:NON_EMPTY_ARRAY');
  if (!Array.isArray(contract?.definitionOfDone) || contract.definitionOfDone.length === 0) errors.push('definitionOfDone:NON_EMPTY_ARRAY');
  for (const [index, predicate] of (contract?.definitionOfDone || []).entries()) {
    for (const key of ['predicateId', 'predicate', 'evidenceType', 'evaluator', 'threshold']) {
      if (predicate?.[key] === undefined || predicate?.[key] === null || predicate?.[key] === '') errors.push(`definitionOfDone[${index}]:${key}`);
    }
  }
  if (contract?.authorityProfile?.humanApprovalPrincipal !== 'H-01') errors.push('authorityProfile:humanApprovalPrincipal:H-01_REQUIRED');
  if (contract?.invariants?.includes?.('AI_MAY_APPROVE_HIGH_RISK_ACTIONS')) errors.push('invariants:AI_APPROVAL_FORBIDDEN');
  return errors;
};

export const normalizeGoalContract = (input = {}) => {
  const intentOriginal = asText(input.intentOriginal || input.intent);
  if (!intentOriginal) throw new Error('GOAL_INTENT_REQUIRED');
  const contract = {
    schemaVersion: 'UNIVERSAL-GOAL-CONTRACT-2.0',
    goalId: asText(input.goalId, buildGoalId(intentOriginal)),
    tenantId: asText(input.tenantId, 'SIMULATION-TENANT'),
    owner: asText(input.owner, 'H-01'),
    intentOriginal,
    outcomeNormalized: asText(input.outcomeNormalized, intentOriginal),
    goalArchetypes: asArray(input.goalArchetypes || ['OPERATIONS']).map(asText).filter(Boolean),
    definitionOfDone: asArray(input.definitionOfDone),
    baseline: input.baseline ?? null,
    target: input.target ?? null,
    observationWindow: input.observationWindow ?? { start: null, end: null },
    attributionRule: input.attributionRule ?? 'CONTRIBUTION_EVIDENCE_ONLY',
    scopeIn: asArray(input.scopeIn),
    scopeOut: asArray(input.scopeOut),
    constraints: asArray(input.constraints),
    invariants: asArray(input.invariants).concat('AI_MAY_NOT_APPROVE_HIGH_RISK_ACTIONS'),
    assumptions: asArray(input.assumptions),
    dependencies: asArray(input.dependencies),
    humanDependencies: asArray(input.humanDependencies).concat('H-01 approval for high-risk external actions'),
    externalUncertainties: asArray(input.externalUncertainties),
    budget: input.budget ?? { money: 0, tokens: null, elapsedTimeMinutes: null, humanMinutes: null },
    authorityProfile: input.authorityProfile ?? { id: 'AP-B2B-STANDARD', humanApprovalPrincipal: 'H-01', allowedWriteActions: [], prohibitedActions: ['SIGN_CONTRACT', 'RELEASE_PAYMENT', 'LEGAL_FILING'] },
    dataClassification: asText(input.dataClassification, 'INTERNAL'),
    environment: asText(input.environment, 'simulation'),
    deadline: input.deadline ?? 'UNSPECIFIED',
    priority: asText(input.priority, 'NORMAL'),
    preemptionPolicy: asText(input.preemptionPolicy, 'SAFETY_THEN_DEADLINE_THEN_VALUE'),
    stopConditions: asArray(input.stopConditions).concat('LEGAL_OR_POLICY_CONFLICT', 'HUMAN_STOP_REQUEST'),
    reportingPolicy: asText(input.reportingPolicy, 'exception_and_milestone'),
    domainPackVersions: input.domainPackVersions ?? {},
    policySnapshot: input.policySnapshot ?? { id: 'POLICY-SIMULATION-DEFAULT', capturedAt: new Date().toISOString() },
    status: asText(input.status, 'NORMALIZED'),
    feasibilityScore: Number.isFinite(input.feasibilityScore) ? input.feasibilityScore : 0.5,
    ambiguityScore: Number.isFinite(input.ambiguityScore) ? input.ambiguityScore : 0.5,
    driftScore: Number.isFinite(input.driftScore) ? input.driftScore : 0,
    createdAt: input.createdAt || new Date().toISOString(),
  };
  const errors = validateGoalContract(contract);
  if (errors.length) {
    const error = new Error(`GOAL_CONTRACT_INVALID:${errors.join(',')}`);
    error.code = 'GOAL_CONTRACT_INVALID';
    error.errors = errors;
    throw error;
  }
  return contract;
};
