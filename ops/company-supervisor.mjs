import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.COMPANY_PORT || process.env.PORT || 4173);
const appEnv = process.env.APP_ENV || 'simulation';
const persistenceMode = process.env.PERSISTENCE_MODE || 'memory';
const persistenceFile = process.env.PERSISTENCE_FILE || '';
const intervalMs = Math.max(1000, Number(process.env.COMPANY_SUPERVISOR_INTERVAL_MS || 5000));
const healthTimeoutMs = Math.max(500, Number(process.env.COMPANY_SUPERVISOR_HEALTH_TIMEOUT_MS || 3000));
const maxRestarts = Math.max(0, Number(process.env.COMPANY_SUPERVISOR_MAX_RESTARTS || 3));
const restartWindowMs = Math.max(1000, Number(process.env.COMPANY_SUPERVISOR_RESTART_WINDOW_MS || 10 * 60 * 1000));
const daemonIntervalMs = Math.max(1000, Number(process.env.OPS_DAEMON_INTERVAL_MS || 15 * 60 * 1000));
const daemonCycleTimeoutMs = Math.max(1000, Number(process.env.OPS_DAEMON_CYCLE_TIMEOUT_MS || 10 * 60 * 1000));
const daemonStatusPath = resolve(root, process.env.OPS_DAEMON_STATUS_PATH || 'ops/daemon-status.json');
const runtimePath = resolve(root, process.env.COMPANY_RUNTIME_PATH || 'ops/company-mode-runtime.json');
const statusPath = resolve(root, process.env.COMPANY_SUPERVISOR_STATUS_PATH || 'ops/company-supervisor-status.json');
const healthUrl = `http://127.0.0.1:${port}/api/health`;
const supervisorStartedAt = new Date().toISOString();

let stopping = false;
let serverChild = null;
let daemonChild = null;
let serverStarted = false;
let daemonStarted = false;
let consecutiveHealthFailures = 0;
const restartHistory = [];

const status = {
  schemaVersion: 'COMPANY-SUPERVISOR-STATUS-0.1',
  pid: process.pid,
  status: 'STARTING',
  updatedAt: new Date().toISOString(),
  appEnv,
  persistenceMode,
  port,
  healthUrl,
  restartPolicy: { maxRestarts, restartWindowMs },
  serverRestarts: 0,
  daemonRestarts: 0,
  consecutiveHealthFailures: 0,
  daemonStatus: null,
  daemonReviewRequired: false,
  lastEvent: null,
  lastError: null,
};

const log = (event, details = {}) => {
  console.log(JSON.stringify({ component: 'company-supervisor', event, at: new Date().toISOString(), ...details }));
};

const parseJson = (text) => JSON.parse(String(text).replace(/^\uFEFF/, ''));

const writeStatus = async (updates = {}) => {
  Object.assign(status, updates, { updatedAt: new Date().toISOString() });
  await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
};

const writeRuntime = async (updates = {}) => {
  let current = {};
  try { current = parseJson(await readFile(runtimePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runtime = {
    ...current,
    schemaVersion: 'COMPANY-MODE-RUNTIME-0.1',
    startedAt: current.status === 'RUNNING' && current.supervised ? current.startedAt : supervisorStartedAt,
    status: 'RUNNING',
    appEnv,
    persistenceMode,
    port,
    healthUrl,
    serverPid: serverChild?.pid || null,
    opsDaemonPid: daemonChild?.pid || null,
    supervisorPid: process.pid,
    intervalMs: daemonIntervalMs,
    cycleTimeoutMs: daemonCycleTimeoutMs,
    monitorBaseUrl: healthUrl.replace('/api/health', ''),
    daemonRequired: true,
    realTradingEnabled: false,
    externalNotificationSent: false,
    stoppedAt: null,
    stoppedProcesses: [],
    supervised: true,
    stopRule: '헬스체크 실패·릴리스 NO_GO·운영 사고 시 거래·계약·결제·공개 재개를 자동 승인하지 않는다.',
    ...updates,
  };
  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
};

const terminate = (child) => {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.unref?.();
  }
  try { child.kill('SIGTERM'); } catch {}
};

const childAlive = (child) => Boolean(child && child.exitCode === null && !child.killed);

const fetchHealth = async () => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`health 응답 코드 ${response.status}`);
    const body = await response.json();
    if (body.service !== 'raw-material-beta') throw new Error('canonical service identity가 아닙니다.');
    if (body.eventStream !== 'SSE') throw new Error('SSE 이벤트 스트림이 아닙니다.');
    return body;
  } finally {
    clearTimeout(timeoutId);
  }
};

const readDaemonStatus = async () => {
  try {
    return parseJson(await readFile(daemonStatusPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const daemonStatusFresh = (daemonStatus) => {
  const updatedAt = Date.parse(daemonStatus?.updatedAt || '');
  const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : null;
  return Boolean(daemonStatus && ageMs !== null && ageMs <= Math.max(daemonIntervalMs * 2, 20 * 60 * 1000));
};

const pruneRestartHistory = () => {
  const cutoff = Date.now() - restartWindowMs;
  while (restartHistory.length && restartHistory[0] < cutoff) restartHistory.shift();
};

const reserveRestart = (component) => {
  pruneRestartHistory();
  if (restartHistory.length >= maxRestarts) return false;
  restartHistory.push(Date.now());
  if (component === 'server') status.serverRestarts += 1;
  if (component === 'daemon') status.daemonRestarts += 1;
  status.lastEvent = `${component}_restarted`;
  return true;
};

const spawnServer = () => {
  const env = { ...process.env, PORT: String(port), APP_ENV: appEnv, PERSISTENCE_MODE: persistenceMode };
  if (persistenceFile) env.PERSISTENCE_FILE = persistenceFile;
  else delete env.PERSISTENCE_FILE;
  const serverArgs = persistenceMode === 'sqlite' ? ['--experimental-sqlite', resolve(root, 'beta-app/server.mjs')] : [resolve(root, 'beta-app/server.mjs')];
  const child = spawn(process.execPath, serverArgs, { cwd: root, env, stdio: 'inherit' });
  child.once('exit', (code, signal) => {
    if (serverChild === child) serverChild = null;
    log('server_exit', { code, signal, stopping });
    if (!stopping) void writeStatus({ lastEvent: 'server_exit', lastError: `server exit code=${code ?? 'null'} signal=${signal || 'none'}` });
  });
  return child;
};

const spawnDaemon = () => {
  const child = spawn(process.execPath, [resolve(root, 'ops/ops-daemon.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      OPS_DAEMON_INTERVAL_MS: String(daemonIntervalMs),
      OPS_DAEMON_CYCLE_TIMEOUT_MS: String(daemonCycleTimeoutMs),
      OPS_DAEMON_STATUS_PATH: daemonStatusPath,
      OPS_DAEMON_RUN_ON_START: 'true',
      MONITOR_REQUIRE_SUPERVISOR: 'true',
      MONITOR_SUPERVISOR_STATUS_PATH: statusPath,
    },
    stdio: 'inherit',
  });
  child.once('exit', (code, signal) => {
    if (daemonChild === child) daemonChild = null;
    log('daemon_exit', { code, signal, stopping });
    if (!stopping) void writeStatus({ lastEvent: 'daemon_exit', lastError: `daemon exit code=${code ?? 'null'} signal=${signal || 'none'}` });
  });
  return child;
};

const stopChildren = () => {
  terminate(daemonChild);
  terminate(serverChild);
  daemonChild = null;
  serverChild = null;
};

const haltForHuman = async (reason) => {
  stopping = true;
  stopChildren();
  await writeStatus({ status: 'HALTED_REQUIRES_H01', lastEvent: 'halted_requires_h01', lastError: reason, consecutiveHealthFailures });
  await writeRuntime({ status: 'HALTED_REQUIRES_H01', stoppedAt: new Date().toISOString(), serverPid: null, opsDaemonPid: null });
  log('halted_requires_h01', { reason });
  process.exitCode = 1;
};

const ensureServer = async () => {
  if (childAlive(serverChild)) return;
  const isRestart = serverStarted;
  if (isRestart && !reserveRestart('server')) return haltForHuman('서버가 반복 중단되어 자동 재시작 한도를 초과했습니다.');
  serverStarted = true;
  serverChild = spawnServer();
  await writeStatus({ lastEvent: isRestart ? 'server_restarted' : 'server_started' });
  await writeRuntime();
  log('server_started', { pid: serverChild.pid, restartCount: status.serverRestarts });
};

const ensureDaemon = async () => {
  if (childAlive(daemonChild)) return;
  const isRestart = daemonStarted;
  if (isRestart && !reserveRestart('daemon')) return haltForHuman('운영 데몬이 반복 중단되어 자동 재시작 한도를 초과했습니다.');
  daemonStarted = true;
  daemonChild = spawnDaemon();
  await writeStatus({ lastEvent: isRestart ? 'daemon_restarted' : 'daemon_started' });
  await writeRuntime();
  log('daemon_started', { pid: daemonChild.pid, restartCount: status.daemonRestarts });
};

const check = async () => {
  if (stopping) return;
  await ensureServer();
  if (stopping) return;
  await ensureDaemon();
  if (stopping) return;
  try {
    await fetchHealth();
    consecutiveHealthFailures = 0;
    const daemonStatus = await readDaemonStatus();
    if (!daemonStatusFresh(daemonStatus) && childAlive(daemonChild)) {
      log('daemon_status_stale', { daemonStatusPath });
      terminate(daemonChild);
    }
    const daemonReviewRequired = Number(daemonStatus?.lastCycleExitCode || 0) !== 0;
    await writeStatus({
      status: 'RUNNING',
      consecutiveHealthFailures: 0,
      lastError: null,
      serverPid: serverChild?.pid || null,
      daemonPid: daemonChild?.pid || null,
      daemonStatus: daemonStatus ? {
        status: daemonStatus.status || 'NOT_REPORTED',
        lastCycle: daemonStatus.lastCycle || null,
        lastCycleExitCode: Number.isFinite(Number(daemonStatus.lastCycleExitCode)) ? Number(daemonStatus.lastCycleExitCode) : null,
        lastCycleDecision: daemonStatus.lastCycleDecision || null,
        lastCycleTimedOut: daemonStatus.lastCycleTimedOut === true,
      } : null,
      daemonReviewRequired,
    });
    await writeRuntime();
  } catch (error) {
    consecutiveHealthFailures += 1;
    await writeStatus({ status: 'DEGRADED', consecutiveHealthFailures, lastError: error.message, serverPid: serverChild?.pid || null, daemonPid: daemonChild?.pid || null });
    log('health_failed', { consecutiveHealthFailures, error: error.message });
    if (consecutiveHealthFailures >= 2 && childAlive(serverChild)) {
      if (!reserveRestart('server')) return haltForHuman(`헬스체크 실패가 반복되어 자동 재시작 한도를 초과했습니다: ${error.message}`);
      terminate(serverChild);
    }
  }
};

const ensureNoExistingCanonicalServer = async () => {
  try {
    const existing = await fetchHealth();
    throw new Error(`COMPANY_MODE_ALREADY_RUNNING: canonical server가 이미 응답합니다 (${existing.service}).`);
  } catch (error) {
    if (String(error.message).startsWith('COMPANY_MODE_ALREADY_RUNNING:')) throw error;
  }
};

const stop = async (signal = 'operator') => {
  if (stopping) return;
  stopping = true;
  stopChildren();
  await writeStatus({ status: 'STOPPED', lastEvent: 'stopped', stopReason: signal, serverPid: null, daemonPid: null });
  await writeRuntime({ status: 'STOPPED', stoppedAt: new Date().toISOString(), stoppedProcesses: [], serverPid: null, opsDaemonPid: null });
  log('stopped', { signal });
};

await access(resolve(root, 'beta-app/server.mjs'));
await access(resolve(root, 'ops/ops-daemon.mjs'));
await ensureNoExistingCanonicalServer();
await writeStatus({ status: 'STARTING', lastEvent: 'starting' });
await ensureServer();
await ensureDaemon();
await writeStatus({ status: 'RUNNING', serverPid: serverChild?.pid || null, daemonPid: daemonChild?.pid || null });
await writeRuntime();
log('started', { port, appEnv, persistenceMode, intervalMs, maxRestarts });

process.on('SIGINT', () => { void stop('SIGINT').then(() => process.exit(0)); });
process.on('SIGTERM', () => { void stop('SIGTERM').then(() => process.exit(0)); });

while (!stopping) {
  await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  await check();
}

