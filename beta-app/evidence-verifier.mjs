import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const policyPath = resolve(fileURLToPath(new URL('../data/evidence-policy.json', import.meta.url)));
const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

const clone = (value) => JSON.parse(JSON.stringify(value));

export const hashDocument = (content) => createHash('sha256').update(String(content), 'utf8').digest('hex');
export const loadEvidencePolicy = () => clone(policy);

const isSha256 = (value) => /^[a-f0-9]{64}$/i.test(String(value || ''));

export const verifyEvidenceBundle = ({ lotId, evidence = [], now = new Date() } = {}) => {
  const referenceTime = new Date(now);
  const recordsByType = new Map();
  const duplicateTypes = [];
  for (const record of evidence) {
    if (recordsByType.has(record.evidenceType)) duplicateTypes.push(record.evidenceType);
    recordsByType.set(record.evidenceType, record);
  }
  const checks = policy.requiredTypes.map((evidenceType) => {
    const record = recordsByType.get(evidenceType);
    const expiresAt = record ? new Date(record.expiresAt || '') : null;
    const valid = Boolean(record)
      && record.lotId === lotId
      && record.state === 'VALID'
      && isSha256(record.contentSha256)
      && !Number.isNaN(expiresAt.valueOf())
      && expiresAt >= referenceTime;
    return {
      evidenceType,
      valid,
      reason: !record ? 'MISSING' : record.lotId !== lotId ? 'LOT_MISMATCH' : record.state !== 'VALID' ? 'NOT_VALID' : !isSha256(record.contentSha256) ? 'INVALID_HASH' : Number.isNaN(expiresAt.valueOf()) || expiresAt < referenceTime ? 'EXPIRED_OR_INVALID_DATE' : null,
      evidenceId: record?.evidenceId || null,
    };
  });
  const duplicateCheck = { evidenceType: 'DUPLICATE_TYPE', valid: duplicateTypes.length === 0, duplicateTypes };
  const allValid = checks.every((check) => check.valid) && duplicateCheck.valid;
  return {
    lotId,
    status: allValid ? 'VALID' : 'BLOCKED',
    preTradeEligible: allValid,
    verifiedAt: referenceTime.toISOString(),
    checks: [...checks, duplicateCheck],
    missing: checks.filter((check) => check.reason === 'MISSING').map((check) => check.evidenceType),
    invalid: checks.filter((check) => !check.valid && check.reason !== 'MISSING').map((check) => check.evidenceType),
    duplicateTypes,
    policyId: policy.schemaVersion,
  };
};
