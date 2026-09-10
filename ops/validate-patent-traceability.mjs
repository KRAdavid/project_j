import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const trace = JSON.parse(await readFile(resolve(root, 'data', 'patent-claim-traceability.json'), 'utf8'));
assert.equal(trace.schemaVersion, 'PATENT-TRACE-0.1');
assert.equal(trace.legalStatus, 'INVENTION_DISCLOSURE_ONLY');
assert.equal(trace.patentabilityGuarantee, false);
assert.equal(trace.elements.length, 7);
assert.deepEqual(trace.elements.map((element) => element.id), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']);
assert.ok(trace.elements.every((element) => element.implementation.length >= 3 && element.tests.length >= 2 && element.humanGate));
for (const element of trace.elements) {
  for (const relativePath of [...element.implementation, ...element.tests]) await access(resolve(root, relativePath));
}
assert.ok(trace.externalReviewRequired.includes('official prior-art search'));
assert.ok(trace.prohibitedExternalClaims.includes('특허 등록 보장'));
console.log(`patent traceability contract tests: PASS (${trace.elements.length} elements)`);

