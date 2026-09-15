import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-supervisor-attach-fail-closed-'));
const getAvailablePort = async () => new Promise((resolvePort, reject) => {
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const selectedPort = address && typeof address === 'object' ? address.port : null;
    probe.close((error) => error ? reject(error) : resolvePort(selectedPort));
  });
});
const port = await getAvailablePort();
if (!port) throw new Error('fail-closed attach test could not reserve a loopback port');
const runtimePath = join(tempRoot, 'runtime.json');
const ledgerPath = join(tempRoot, 'ledger.sqlite');
const supervisorStatusPath = join(tempRoot, 'supervisor-status.json');
const daemonStatusPath = join(tempRoot, 'daemon-status.json');
await writeFile(daemonStatusPath, `${JSON.stringify({
  schemaVersion: 'OPS-DAEMON-STATUS-0.1',
  pid: process.pid,
  status: 'WAITING',
  cycleCount: 1,
  lastCycle: 1,
  lastCycleExitCode: 0,
  updatedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
}, null, 2)}\n`, 'utf8');

const server = spawn(process.execPath, ['--experimental-sqlite', 'beta-app/server.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', PERSISTENCE_MODE: 'sqlite', PERSISTENCE_FILE: ledgerPath },
  stdio: 'ignore',
});
const supervisor = spawn(process.execPath, ['ops/company-supervisor.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    COMPANY_PORT: String(port),
    APP_ENV: 'simulation',
    PERSISTENCE_MODE: 'sqlite',
    COMPANY_ATTACH_EXISTING: 'true',
    COMPANY_SUPERVISOR_INTERVAL_MS: '250',
    COMPANY_SUPERVISOR_HEALTH_TIMEOUT_MS: '1000',
    COMPANY_RUNTIME_PATH: runtimePath,
    COMPANY_SUPERVISOR_STATUS_PATH: supervisorStatusPath,
    OPS_DAEMON_STATUS_PATH: daemonStatusPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
supervisor.stdout.on('data', (chunk) => logs.push(String(chunk)));
supervisor.stderr.on('data', (chunk) => logs.push(String(chunk)));
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const fetchHealth = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok ? response.json() : null;
  } catch { return null; }
};
const waitUntil = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
};
const killTree = (processId) => {
  if (!processId || processId <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {}
  }
  try { process.kill(processId, 'SIGTERM'); } catch {}
};

try {
  assert.equal(await waitUntil(async () => (await fetchHealth())?.service === 'raw-material-beta'), true, 'existing server must become healthy');
  const exited = await waitUntil(() => supervisor.exitCode !== null, 5000);
  if (!exited) console.error(`supervisor did not fail closed; logs:\n${logs.join('')}`);
  assert.equal(exited, true, 'stale attach evidence must fail during startup');
  assert.notEqual(supervisor.exitCode, 0);
  assert.match(logs.join(''), /COMPANY_ATTACH_EXISTING_REQUIRES_/);
  console.log('company supervisor attach fail-closed integration: PASS');
} finally {
  killTree(supervisor.pid);
  killTree(server.pid);
  await waitUntil(() => supervisor.exitCode !== null, 3000);
  await waitUntil(() => server.exitCode !== null, 5000);
  await rm(tempRoot, { recursive: true, force: true });
}

