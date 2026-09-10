import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';

const root = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-supervisor-'));
const getAvailablePort = async () => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const selectedPort = address && typeof address === 'object' ? address.port : null;
    probe.close((error) => error ? reject(error) : resolve(selectedPort));
  });
});
const port = await getAvailablePort();
if (!port) throw new Error('supervisor integration test could not reserve a loopback port');
const runtimePath = join(tempRoot, 'runtime.json');
const ledgerPath = join(tempRoot, 'ledger.sqlite');
const supervisorStatusPath = join(tempRoot, 'supervisor-status.json');
const daemonStatusPath = join(tempRoot, 'daemon-status.json');
const env = {
  ...process.env,
  COMPANY_PORT: String(port),
  COMPANY_SUPERVISOR_INTERVAL_MS: '250',
  COMPANY_SUPERVISOR_HEALTH_TIMEOUT_MS: '1000',
  COMPANY_SUPERVISOR_MAX_RESTARTS: '2',
  COMPANY_RUNTIME_PATH: runtimePath,
  PERSISTENCE_MODE: 'sqlite',
  PERSISTENCE_FILE: ledgerPath,
  COMPANY_SUPERVISOR_STATUS_PATH: supervisorStatusPath,
  OPS_DAEMON_STATUS_PATH: daemonStatusPath,
  OPS_DAEMON_CYCLE_SCRIPT: 'ops/test-company-supervisor.mjs',
  OPS_DAEMON_INTERVAL_MS: '60000',
  OPS_DAEMON_CYCLE_TIMEOUT_MS: '300000',
  OPS_DAEMON_MAX_CYCLES: '0',
  OPS_DAEMON_CHILD_STDIO: 'ignore',
};

const supervisor = spawn(process.execPath, ['ops/company-supervisor.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const supervisorLogs = [];
supervisor.stdout.on('data', (chunk) => supervisorLogs.push(String(chunk)));
supervisor.stderr.on('data', (chunk) => supervisorLogs.push(String(chunk)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const killTree = (processId) => {
  if (!processId || processId <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {}
  }
  try { process.kill(processId, 'SIGTERM'); return; } catch {}
  try { process.kill(processId, 'SIGTERM'); } catch {}
};

try {
  assert.equal(await waitUntil(async () => (await fetchHealth())?.service === 'raw-material-beta'), true, 'supervised server must become healthy');
  assert.equal(await waitUntil(async () => {
    const current = await readJson(supervisorStatusPath);
    return current.status === 'RUNNING' && current.serverPid > 0;
  }), true, 'supervisor status must converge to RUNNING after health is ready');
  const firstStatus = await readJson(supervisorStatusPath);
  assert.equal(firstStatus.status, 'RUNNING');
  assert.ok(firstStatus.serverPid > 0);
  const firstServerPid = firstStatus.serverPid;
  killTree(firstServerPid);
  assert.equal(await waitUntil(async () => {
    const current = await readJson(supervisorStatusPath);
    return current.serverRestarts >= 1 && current.serverPid > 0 && current.serverPid !== firstServerPid;
  }), true, 'supervisor must restart a failed server');
  assert.equal(await waitUntil(async () => (await fetchHealth())?.service === 'raw-material-beta', 5000), true, 'restarted server must become healthy');
  const runtime = await readJson(runtimePath);
  assert.equal(runtime.realTradingEnabled, false);
  assert.equal(runtime.supervised, true);
  assert.equal(runtime.persistenceMode, 'sqlite');
  assert.equal(runtime.stoppedAt, null);
  assert.deepEqual(runtime.stoppedProcesses, []);
  await access(ledgerPath);
  console.log('company supervisor integration: PASS');
} catch (error) {
  console.error(`company supervisor diagnostics:\n${supervisorLogs.join('')}`);
  throw error;
} finally {
  killTree(supervisor.pid);
  await waitUntil(() => supervisor.exitCode !== null, 3000);
  await rm(tempRoot, { recursive: true, force: true });
}
