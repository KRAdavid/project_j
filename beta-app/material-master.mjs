import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalogPath = resolve(fileURLToPath(new URL('../data/material-master.json', import.meta.url)));
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const normalize = (value) => String(value || '').trim().toLocaleLowerCase('ko-KR').replace(/\s+/g, '');

export const validateMaterialMaster = (input = catalog) => {
  if (!input.schemaVersion?.startsWith('MMS-') || input.catalogStatus !== 'SIMULATION_ONLY' || !Array.isArray(input.records)) return false;
  return input.records.every((record) => (
    Boolean(record.materialId)
    && Boolean(record.canonicalName)
    && Array.isArray(record.aliases)
    && record.aliases.length > 0
    && Boolean(record.specStatus)
    && Boolean(record.simulationSpec?.specId)
    && Array.isArray(record.requiredSpecFields)
    && record.requiredSpecFields.every((field) => Object.prototype.hasOwnProperty.call(record.simulationSpec, field))
    && Array.isArray(record.specQuestionFlow)
    && record.specQuestionFlow.length >= record.requiredSpecFields.length
    && record.requiredSpecFields.every((field) => record.specQuestionFlow.some((question) => question.field === field && question.required === true && Array.isArray(question.options) && question.options.length > 0))
    && Array.isArray(record.requiredEvidence)
    && record.tradeProfile?.physicalMaterialOnly === true
    && record.tradeProfile?.currency
    && record.tradeProfile?.baseUnit
    && record.tradeProfile?.priceUnit
    && record.tradeProfile?.orderQuantityUnit
    && record.regulatoryProfile?.status
    && Array.isArray(record.regulatoryProfile?.jurisdictions)
    && record.storageProfile?.temperature
    && record.riskProfile?.level
    && Array.isArray(record.riskProfile?.preTradeGates)
    && record.provenance?.sourceStatus
  ));
};

if (!validateMaterialMaster()) throw new Error('Material Master Schema 검증에 실패했습니다.');

export const resolveMaterial = (query, source = catalog) => {
  const normalizedQuery = normalize(query);
  const records = Array.isArray(source?.records) ? source.records : [];
  const record = records.find((candidate) => (
    normalize(candidate.materialId) === normalizedQuery
    || normalize(candidate.canonicalName) === normalizedQuery
    || candidate.aliases.some((alias) => normalize(alias) === normalizedQuery)
  ));
  if (!record) return null;
  return JSON.parse(JSON.stringify({
    materialId: record.materialId,
    canonicalName: record.canonicalName,
    matchedAlias: query,
    aliases: record.aliases,
    specStatus: record.specStatus,
    simulationSpec: record.simulationSpec,
    requiredSpecFields: record.requiredSpecFields,
    specQuestionFlow: record.specQuestionFlow,
    requiredEvidence: record.requiredEvidence,
    materialClass: record.materialClass,
    identifiers: record.identifiers,
    tradeProfile: record.tradeProfile,
    regulatoryProfile: record.regulatoryProfile,
    storageProfile: record.storageProfile,
    riskProfile: record.riskProfile,
    provenance: record.provenance,
  }));
};

const publicMaterial = (record, query, matchType) => ({
  materialId: record.materialId,
  canonicalName: record.canonicalName,
  matchedAlias: query,
  aliases: record.aliases,
  materialClass: record.materialClass,
  specStatus: record.specStatus,
  simulationSpec: record.simulationSpec,
  requiredSpecFields: record.requiredSpecFields,
  specQuestionFlow: record.specQuestionFlow,
  requiredEvidence: record.requiredEvidence,
  tradeProfile: record.tradeProfile,
  regulatoryProfile: record.regulatoryProfile,
  storageProfile: record.storageProfile,
  riskProfile: record.riskProfile,
  provenance: record.provenance,
  matchType,
});

/** Return ranked candidates without selecting or confirming a trade spec. */
export const searchMaterials = (query, { limit = 10, source = catalog } = {}) => {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 10));
  const records = Array.isArray(source?.records) ? source.records : [];
  return records
    .map((record) => {
      const values = [record.materialId, record.canonicalName, ...(record.aliases || [])].map(normalize);
      const exact = values.some((value) => value === normalizedQuery);
      const prefix = !exact && values.some((value) => value.startsWith(normalizedQuery));
      const contains = !exact && !prefix && values.some((value) => value.includes(normalizedQuery));
      if (!exact && !prefix && !contains) return null;
      return { record, score: exact ? 3 : prefix ? 2 : 1, matchType: exact ? 'EXACT' : prefix ? 'PREFIX' : 'CONTAINS' };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.record.materialId.localeCompare(right.record.materialId))
    .slice(0, safeLimit)
    .map(({ record, matchType }) => publicMaterial(record, query, matchType));
};

export const materialMasterSnapshot = () => JSON.parse(JSON.stringify(catalog));

