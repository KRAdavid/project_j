import assert from 'node:assert/strict';
import { buildCutoverInputManifest } from './cutover-input-manifest.mjs';

const manifest = buildCutoverInputManifest({
  generatedAt: '2026-09-09T00:00:00.000Z',
  sourceRunId: 'RUN-TEST',
  readiness: {
    decision: 'NO_GO',
    diagnostics: [{ id: 'R-01', status: 'MISSING', missing: ['DATABASE_URL'] }, { id: 'R-07', status: 'MISSING', missing: ['SHADOW_PILOT_APPROVAL_REF'] }],
    checks: [{ id: 'R-01', name: 'durable_persistence', required: true, current: false, evidence: 'data/persistence-config.json' }, { id: 'R-03', name: 'evidence', required: true, current: true }, { id: 'R-07', name: 'shadow_pilot_human_approval', required: true, current: false, evidence: 'ops/shadow-pilot-plan.json' }],
  },
  stagingPreflight: { status: 'BLOCKED', missing: ['DATABASE_URL'], secretValuesRedacted: true },
  githubTargetPreflight: { status: 'BLOCKED', missing: ['TARGET_REPOSITORY'], secretValuesRedacted: true },
});
assert.equal(manifest.items.length, 3);
assert.equal(manifest.items.find((item) => item.id === 'R-01').ownerAi, 'AI-10 아틀라스');
assert.deepEqual(manifest.items.find((item) => item.id === 'R-01').requiredEnvironmentKeys, ['DATABASE_URL']);
assert.equal(manifest.items.find((item) => item.id === 'R-07').status, 'HUMAN_APPROVAL_REQUIRED');
assert.equal(manifest.infrastructure.secretValuesRedacted, true);
const missingEvidenceManifest = buildCutoverInputManifest({ readiness: { decision: 'NO_GO', checks: [] }, stagingPreflight: null, githubTargetPreflight: null });
assert.equal(missingEvidenceManifest.infrastructure.stagingPreflightStatus, 'NOT_AVAILABLE');
assert.equal(missingEvidenceManifest.infrastructure.githubTargetStatus, 'NOT_AVAILABLE');
console.log('cutover input manifest tests: PASS');

