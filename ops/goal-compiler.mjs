import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGoalContract } from './goal-contract.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const domainPackPath = resolve(root, 'data/domain-pack.raw-material-os-gaba.json');

const readDomainPack = async () => JSON.parse(await readFile(domainPackPath, 'utf8'));

const isRawMaterialIntent = (intent) => /GABA|가바|원료|거래소|공급|납품/i.test(intent);

export const compileGoal = async ({ intent, context = {} } = {}) => {
  const raw = String(intent || '').trim();
  if (!raw) throw new Error('GOAL_INTENT_REQUIRED');
  const rawMaterial = isRawMaterialIntent(raw);
  const domainPack = rawMaterial ? await readDomainPack() : null;
  const archetypes = rawMaterial ? ['VALIDATION', 'TRANSACTION_EXECUTION', 'OPERATIONS'] : ['OPERATIONS'];
  const definitionOfDone = context.definitionOfDone || domainPack?.definitionOfDoneTemplates || [{
    predicateId: 'OUTCOME_OBSERVED',
    predicate: '목표 결과가 독립 검증 가능한 증거로 관찰되었다.',
    evidenceType: 'OUTCOME_OBSERVATION',
    evaluator: 'AI-09 콘트라',
    threshold: 1,
  }];
  const contract = normalizeGoalContract({
    ...context,
    intentOriginal: raw,
    outcomeNormalized: context.outcomeNormalized || (rawMaterial ? '원료 요구를 표준 스펙과 검증 가능한 실물 거래 결과로 전환한다.' : raw),
    goalArchetypes: context.goalArchetypes || archetypes,
    definitionOfDone,
    domainPackVersions: context.domainPackVersions || (domainPack ? { [domainPack.packId]: domainPack.version } : {}),
    scopeIn: context.scopeIn || (rawMaterial ? ['Material Master', 'evidence gate', 'lot inventory', 'physical trade lifecycle'] : ['goal normalization', 'execution planning', 'outcome verification']),
    scopeOut: context.scopeOut || ['AI contract signature', 'AI payment release', 'unapproved external write'],
    invariants: context.invariants || (domainPack ? ['PRE_TRADE_EVIDENCE_REQUIRED', 'FAKE_LISTING_FAIL_CLOSED'] : []),
  });
  return {
    contract,
    compiler: {
      schemaVersion: 'GOAL-COMPILER-0.1',
      domainPack: domainPack?.packId || null,
      ambiguityScore: contract.ambiguityScore,
      feasibilityScore: contract.feasibilityScore,
      requiresHumanClarification: contract.ambiguityScore >= 0.7,
    },
    firstValidActions: domainPack?.firstValidActions || [{ actionId: 'GENERIC-A1', objective: '목표의 완료 증거와 첫 읽기 작업을 확정한다.', risk: 'LOW', mode: 'READ_ONLY' }],
    executionGuard: { status: 'PREPARE_ONLY', externalWriteAllowed: false, humanApprovalPrincipal: 'H-01' },
  };
};
