import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-supervisor-attach-'));
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
if (!port) throw new Error('attach integration test could not reserve a loopback port');
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
  lastCycleDecision: 'HUMAN_REVIEW_REQUIRED',
  lastCycleMonitorStatus: 'OK',
  lastCycleAutopilotDecision: 'HUMAN_REVIEW_REQUIRED',
  updatedAt: new Date().toISOString(),
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
    OPS_DAEMON_INTERVAL_MS: '60000',
    OPS_DAEMON_CYCLE_TIMEOUT_MS: '300000',
    OPS_DAEMON_CHILD_STDIO: 'ignore',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logs = [];
supervisor.stdout.on('data', (chunk) => logs.push(String(chunk)));
supervisor.stderr.on('data', (chunk) => logs.push(String(chunk)));
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
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
const removeTempRoot = async () => {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOTEMPTY') throw error;
      await sleep(100);
    }
  }
  throw lastError;
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
  assert.equal(await waitUntil(async () => {
    const current = await readJson(supervisorStatusPath);
    return current.status === 'RUNNING' && current.attachedExisting === true && current.daemonPid === process.pid;
  }), true, 'attach supervisor must monitor the existing runtime without spawning children');
  const status = await readJson(supervisorStatusPath);
  const runtime = await readJson(runtimePath);
  assert.equal(status.attachedExisting, true);
  assert.equal(status.lastEvent, 'attached_existing_runtime');
  assert.equal(status.serverPid, null);
  assert.equal(status.daemonPid, process.pid);
  assert.equal(runtime.attachedExisting, true);
  assert.equal(runtime.managedProcesses, false);
  assert.notEqual(runtime.startedAt, '2026-09-12T01:25:03.392Z');
  assert.equal(runtime.realTradingEnabled, false);
  assert.equal(server.exitCode, null, 'attach supervisor must not take ownership of the existing server');
  console.log('company supervisor attach integration: PASS');
} catch (error) {
  console.error(`company supervisor attach diagnostics:\n${logs.join('')}`);
  throw error;
} finally {
  killTree(supervisor.pid);
  killTree(server.pid);
  await waitUntil(() => supervisor.exitCode !== null, 5000);
  await waitUntil(() => server.exitCode !== null, 5000);
  await removeTempRoot();
}

