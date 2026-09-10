import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const buildOutcomeObservation = ({ outcomeId, value, baseline = null, source, evidenceLevel = 'UNVERIFIED', confidence = 0, causalLink = 'UNKNOWN', verifier = null, expiry = null, satisfied = false, ...rest } = {}) => ({
  observationId: rest.observationId || `OBS-${randomUUID()}`,
  outcomeId: String(outcomeId || '').trim(),
  observedAt: rest.observedAt || new Date().toISOString(),
  source: String(source || '').trim(),
  value,
  baseline,
  evidenceLevel,
  confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
  causalLink,
  verifier,
  expiry,
  satisfied: satisfied === true,
  ...rest,
});

export const calculateGoalProgress = ({ contract, observations = [], now = new Date() } = {}) => {
  const predicates = Array.isArray(contract?.definitionOfDone) ? contract.definitionOfDone : [];
  if (!predicates.length) return { score: 0, satisfiedCount: 0, totalCount: 0, confidence: 0, freshness: 'UNKNOWN', items: [] };
  const items = predicates.map((predicate) => {
    const matches = observations.filter((item) => item.outcomeId === predicate.predicateId && item.satisfied === true);
    const latest = matches.sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)))[0] || null;
    const fresh = latest && (!latest.expiry || new Date(latest.expiry).getTime() >= now.getTime());
    return { predicateId: predicate.predicateId, satisfied: Boolean(fresh), evidenceLevel: latest?.evidenceLevel || 'MISSING', confidence: latest?.confidence || 0, observedAt: latest?.observedAt || null, observationId: latest?.observationId || null };
  });
  const score = items.reduce((sum, item) => sum + (item.satisfied ? 1 : 0), 0) / items.length;
  const confidence = items.reduce((sum, item) => sum + (item.satisfied ? item.confidence : 0), 0) / items.length;
  return { score, satisfiedCount: items.filter((item) => item.satisfied).length, totalCount: items.length, confidence, freshness: items.some((item) => item.satisfied) ? 'CURRENT_OR_PARTIAL' : 'NO_CURRENT_EVIDENCE', items };
};

export const appendOutcomeObservation = async (path, observation) => {
  const record = buildOutcomeObservation(observation);
  if (!record.outcomeId || !record.source) throw new Error('OUTCOME_OBSERVATION_ID_AND_SOURCE_REQUIRED');
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
};

export const readOutcomeObservations = async (path) => {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

