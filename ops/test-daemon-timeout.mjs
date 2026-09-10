import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tempRoot = await mkdtemp(resolve(tmpdir(), 'raw-material-daemon-timeout-'));
const fakeCycle = resolve(tempRoot, 'fake-cycle.mjs');
const statusPath = resolve(tempRoot, 'daemon-status.json');

try {
  await writeFile(fakeCycle, "setInterval(() => {}, 1000);\n", 'utf8');
  const result = spawnSync(process.execPath, [resolve(root, 'ops/ops-daemon.mjs'), '--once'], {
    cwd: root,
    env: {
      ...process.env,
      OPS_DAEMON_CYCLE_SCRIPT: fakeCycle,
      OPS_DAEMON_STATUS_PATH: statusPath,
      OPS_DAEMON_INTERVAL_MS: '1000',
      OPS_DAEMON_CYCLE_TIMEOUT_MS: '1000',
      OPS_DAEMON_RUN_ON_START: 'true',
      OPS_DAEMON_CHILD_STDIO: 'ignore',
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.equal(status.status, 'WAITING');
  assert.equal(status.lastCycleTimedOut, true);
  assert.equal(status.lastCycleExitCode, 1);
  assert.equal(status.lastCycle, 1);
  console.log('daemon timeout recovery tests: PASS');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

