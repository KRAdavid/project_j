import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roster = JSON.parse(await readFile(resolve(root, 'data', 'team-roster.json'), 'utf8'));
const ids = roster.members.map((member) => member.id);
const aiMembers = roster.members.filter((member) => member.kind === 'AI');
assert.equal(roster.schemaVersion, 'TEAM-ROSTER-0.1');
assert.equal(roster.humanApprovalPrincipal, 'H-01');
assert.equal(roster.members.length, 14);
assert.equal(new Set(ids).size, ids.length);
assert.deepEqual(ids, ['H-01', ...Array.from({ length: 13 }, (_, index) => `AI-${String(index + 1).padStart(2, '0')}`)]);
assert.equal(roster.members.filter((member) => member.kind === 'HUMAN').length, 1);
assert.equal(aiMembers.length, 13);
assert.ok(aiMembers.every((member) => member.autonomy === 'ANALYZE_PREPARE'));
assert.ok(roster.prohibitedAiDecisions.includes('TRADE_FINALIZATION'));
assert.ok(roster.prohibitedAiDecisions.includes('PRODUCTION_CUTOVER'));
console.log(`team roster contract tests: PASS (${roster.members.length} members)`);

