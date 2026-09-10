import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = await readFile(resolve(root, 'package.json'), 'utf8');
const read = (path) => readFile(resolve(root, path), 'utf8');
const workflow = await read('.github/workflows/quality-gates.yml');
const cutoverWorkflow = await read('.github/workflows/production-cutover-gate.yml');
const incident = await read('.github/ISSUE_TEMPLATE/critical-incident.yml');
const patent = await read('.github/ISSUE_TEMPLATE/bm-patent-proposal.yml');
const pullRequest = await read('.github/PULL_REQUEST_TEMPLATE.md');

const assertions = [
  ['workflow runs for pushes and pull requests', workflow.includes('push:') && workflow.includes('pull_request:')],
  ['workflow has scheduled execution', workflow.includes('schedule:') && workflow.includes('cron:')],
  ['workflow provisions PostgreSQL evidence', workflow.includes('image: postgres:15') && workflow.includes('DATABASE_URL:')],
  ['workflow validates the staging container build', workflow.includes('docker compose -f compose.staging.yml config') && workflow.includes('docker build --file Dockerfile.staging')],
  ['workflow validates task ownership and human gates', workflow.includes('node ops/validate-task-ownership.mjs') && workflow.includes('node ops/test-task-ownership.mjs')],
  ['workflow validates AI work packets', workflow.includes('node ops/test-work-packet.mjs')],
  ['workflow validates patent disclosure packets', workflow.includes('node ops/test-patent-disclosure-packet.mjs')],
  ['workflow validates release readiness diagnostics', workflow.includes('node beta-app/test-readiness-diagnostics.mjs')],
  ['workflow validates the staging runtime preflight contract', workflow.includes('node ops/test-staging-preflight.mjs')],
  ['workflow validates the GitHub target and origin boundary', workflow.includes('node ops/github-target-preflight.mjs --strict') && workflow.includes('GITHUB_BASE_BRANCH: ${{ github.event.repository.default_branch }}')],
  ['workflow validates company mode start and stop contracts', workflow.includes('node ops/test-company-mode-launcher.mjs') && workflow.includes('node ops/test-company-mode-stop.mjs')],
  ['workflow runs the operations daemon contract test', workflow.includes('node ops/test-ops-daemon.mjs')],
  ['workflow validates company supervisor recovery', workflow.includes('node ops/test-company-supervisor.mjs') && workflow.includes('node ops/test-company-supervisor-integration.mjs')],
  ['workflow validates automatic company mode registration contract', workflow.includes('node ops/test-company-mode-task.mjs')],
  ['workflow verifies daemon timeout recovery and complete local contracts', workflow.includes('node ops/test-daemon-timeout.mjs') && workflow.includes('node ops/validate-contracts.mjs')],
  ['workflow validates daemon liveness and queue compaction', workflow.includes('node ops/test-daemon-liveness.mjs') && workflow.includes('node ops/test-task-queue-compaction.mjs') && cutoverWorkflow.includes('node ops/test-daemon-liveness.mjs')],
  ['workflow uses the pinned pnpm lockfile', packageJson.includes('"packageManager": "pnpm@11.19.0"') && workflow.includes('pnpm/action-setup@v4') && workflow.includes('pnpm install --frozen-lockfile') && cutoverWorkflow.includes('pnpm/action-setup@v4') && cutoverWorkflow.includes('pnpm install --frozen-lockfile')],
  ['workflow installs pnpm before enabling setup-node cache', workflow.indexOf('pnpm/action-setup@v4') >= 0 && workflow.indexOf('pnpm/action-setup@v4') < workflow.indexOf('actions/setup-node@v4') && cutoverWorkflow.indexOf('pnpm/action-setup@v4') >= 0 && cutoverWorkflow.indexOf('pnpm/action-setup@v4') < cutoverWorkflow.indexOf('actions/setup-node@v4')],
  ['workflow validates patent prior art and incident ledger', workflow.includes('node ops/test-patent-prior-art.mjs') && workflow.includes('node ops/test-incident-ledger.mjs')],
  ['workflow keeps operational evidence out of public artifacts', !workflow.includes('actions/upload-artifact') && !workflow.includes('ops/latest-executive-review.json') && !workflow.includes('ops/approval-inbox.json')],
  ['production cutover is manual and environment protected', cutoverWorkflow.includes('workflow_dispatch:') && cutoverWorkflow.includes('name: production')],
  ['production cutover reuses the complete contract suite', cutoverWorkflow.includes('node ops/validate-contracts.mjs')],
  ['production cutover runs migration and backup evidence', cutoverWorkflow.includes('node ops/migrate-postgres.mjs') && cutoverWorkflow.includes('node ops/postgres-backup-restore-drill.mjs')],
  ['production cutover has no automatic deployment step', cutoverWorkflow.includes('no automatic deployment') && !cutoverWorkflow.includes('cloudflare deploy')],
  ['production cutover requires supervisor evidence', cutoverWorkflow.includes('SUPERVISOR_CONNECTED:') && cutoverWorkflow.includes('SUPERVISOR_HEARTBEAT_VERIFIED:')],
  ['critical incident form captures cycle and containment', incident.includes('id: cycle-id') && incident.includes('id: containment')],
  ['patent proposal form captures mechanism and prior-art distinction', patent.includes('id: mechanism') && patent.includes('id: distinction')],
  ['pull requests require evidence and safety checks', pullRequest.includes('## 검증 증거') && pullRequest.includes('H-01 승인 없이')],
];

const failures = assertions.filter(([, passed]) => !passed);
if (failures.length) {
  console.error(failures.map(([name]) => `FAIL: ${name}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`github governance contract tests: PASS (${assertions.length})`);
}

