import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const timeoutMs = 30000;
const contracts = [
  'ops/validate-material-master-contract.mjs',
  'ops/validate-persistence-config.mjs',
  'ops/validate-persistence-schema.mjs',
  'ops/validate-postgres-domain-adapter-contract.mjs',
  'ops/validate-postgres-cutover-plan.mjs',
  'ops/validate-price-source-contract.mjs',
  'ops/validate-production-domain-path.mjs',
  'ops/validate-ui-contract.mjs',
  'ops/test-approval-store.mjs',
  'ops/test-approval-sync.mjs',
  'ops/test-autopilot-claim.mjs',
  'ops/test-autopilot-ledger.mjs',
  'ops/test-autopilot-selection.mjs',
  'ops/test-executive-review.mjs',
  'ops/test-github-governance.mjs',
  'ops/test-github-target-preflight.mjs',
  'ops/test-operation-lock.mjs',
  'ops/test-patent-disclosure-packet.mjs',
  'ops/test-patent-claim-outline.mjs',
  'ops/test-shadow-pilot-plan.mjs',
  'ops/test-staging-contract.mjs',
  'ops/test-staging-preflight.mjs',
  'ops/test-trigger-engine.mjs',
  'ops/test-task-sla.mjs',
  'ops/test-task-audit-integrity.mjs',
  'ops/test-task-audit-remediation.mjs',
  'ops/test-work-packet.mjs',
  'ops/test-notification-dispatcher.mjs',
  'ops/test-operator-summary.mjs',
  'ops/test-company-supervisor.mjs',
  'ops/test-company-supervisor-integration.mjs',
  'ops/test-company-mode-task.mjs',
  'beta-app/test-readiness-diagnostics.mjs',
];

const failures = [];
for (const script of contracts) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const passed = !timedOut && result.status === 0;
  console.log(`${passed ? 'PASS' : 'FAIL'} · ${script}${timedOut ? ` · TIMEOUT after ${timeoutMs}ms` : ''}`);
  if (output) console.log(output);
  if (!passed) failures.push({ script, timedOut, status: result.status, error: result.error?.message || null });
}

if (failures.length) {
  console.error(JSON.stringify({ contractCount: contracts.length, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(`contract validation: PASS (${contracts.length})`);
}

