import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cycleScript = resolve(root, process.env.OPS_DAEMON_CYCLE_SCRIPT || 'ops/run-ops-cycle.mjs');
const intervalMs = Math.max(1000, Number(process.env.OPS_DAEMON_INTERVAL_MS || 15 * 60 * 1000));
const cycleTimeoutMs = Math.max(1000, Number(process.env.OPS_DAEMON_CYCLE_TIMEOUT_MS || 10 * 60 * 1000));
const maxCycles = Math.max(0, Number(process.env.OPS_DAEMON_MAX_CYCLES || 0));
const runOnStart = process.env.OPS_DAEMON_RUN_ON_START !== 'false';
const runOnce = process.argv.includes('--once');
const statusPath = resolve(root, process.env.OPS_DAEMON_STATUS_PATH || 'ops/daemon-status.json');
const cycleEvidencePath = resolve(root, process.env.OPS_DAEMON_CYCLE_EVIDENCE_PATH || 'ops/latest-ops-cycle.json');
const daemonStatus = {
  schemaVersion: 'OPS-DAEMON-STATUS-0.1',
  pid: process.pid,
  status: 'STARTING',
  cycleCount: 0,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let stopping = false;
let cycleCount = 0;
let timer = null;
let activeChild = null;

const terminateChildTree = (child, { force = false } = {}) => {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T'];
    if (force) args.push('/F');
    const killer = spawn('taskkill.exe', args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref?.();
  }
  try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
};

const log = (event, details = {}) => {
  console.log(JSON.stringify({
    component: 'ops-daemon',
    event,
    at: new Date().toISOString(),
    ...details,
  }));
};

const writeStatus = async (updates = {}) => {
  Object.assign(daemonStatus, updates, { updatedAt: new Date().toISOString() });
  try {
    await writeFile(statusPath, `${JSON.stringify(daemonStatus, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('status_write_failed', { statusPath, error: error.message });
  }
};

const readCycleOutcome = async () => {
  try {
    const cycle = JSON.parse(await readFile(cycleEvidencePath, 'utf8'));
    return {
      lastCycleDecision: cycle.decision || null,
      lastCycleMonitorStatus: cycle.monitor?.status || null,
      lastCycleAutopilotDecision: cycle.autopilot?.decision || null,
    };
  } catch {
    return {};
  }
};

const runCycle = () => new Promise((resolveCycle) => {
  if (stopping) return resolveCycle({ exitCode: 0, skipped: true });
  cycleCount += 1;
  const startedAt = Date.now();
  let timedOut = false;
  let settled = false;
  let timeoutId = null;
  let forceKillTimer = null;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    activeChild = null;
    void writeStatus({
      status: stopping ? 'STOPPING' : 'WAITING',
      lastCycle: cycleCount,
      lastCycleExitCode: result.exitCode,
      lastCycleDurationMs: result.durationMs || null,
      lastCycleTimedOut: Boolean(result.timedOut),
      lastCycleDecision: result.lastCycleDecision || null,
      lastCycleMonitorStatus: result.lastCycleMonitorStatus || null,
      lastCycleAutopilotDecision: result.lastCycleAutopilotDecision || null,
      lastCycleFinishedAt: new Date().toISOString(),
    });
    resolveCycle(result);
  };
  void writeStatus({ status: 'CYCLE_RUNNING', cycleCount, cycleStartedAt: new Date().toISOString() });
  log('cycle_started', { cycle: cycleCount, intervalMs, cycleTimeoutMs });
  activeChild = spawn(process.execPath, [cycleScript], {
    cwd: root,
    env: { ...process.env, OPS_DAEMON_CYCLE: String(cycleCount) },
    stdio: process.env.OPS_DAEMON_CHILD_STDIO === 'ignore' ? 'ignore' : 'inherit',
  });
  activeChild.once('error', (error) => {
    log('cycle_failed_to_start', { cycle: cycleCount, error: error.message });
    finish({ exitCode: 1, error: error.message, timedOut: false });
  });
  activeChild.once('exit', async (code, signal) => {
    const result = { exitCode: code ?? 1, signal: signal || null, durationMs: Date.now() - startedAt };
    const outcome = timedOut ? {} : await readCycleOutcome();
    log(code === 0 && !timedOut ? 'cycle_finished' : 'cycle_needs_review', { cycle: cycleCount, ...result, ...outcome, timedOut });
    finish({ ...result, ...outcome, timedOut });
  });
  timeoutId = setTimeout(() => {
    if (!activeChild || settled) return;
    timedOut = true;
    log('cycle_timeout', { cycle: cycleCount, timeoutMs: cycleTimeoutMs });
    void writeStatus({ status: 'TIMEOUT', timeoutCycle: cycleCount, timeoutMs: cycleTimeoutMs });
    terminateChildTree(activeChild);
    forceKillTimer = setTimeout(() => {
      if (activeChild && !settled) {
        terminateChildTree(activeChild, { force: true });
        // On Windows taskkill can terminate the child without emitting the
        // expected Node exit event. Resolve the cycle locally so liveness is
        // never left in CYCLE_RUNNING indefinitely.
        finish({
          exitCode: 1,
          signal: 'SIGKILL',
          durationMs: Date.now() - startedAt,
          timedOut: true,
        });
      }
    }, 5000);
  }, cycleTimeoutMs);
});

const stop = () => {
  if (stopping) return;
  stopping = true;
  void writeStatus({ status: 'STOPPING' });
  if (timer) clearTimeout(timer);
  if (activeChild) terminateChildTree(activeChild);
  log('stopped', { completedCycles: cycleCount });
  if (!activeChild) process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const loop = async () => {
  if (runOnStart || runOnce) await runCycle();
  if (runOnce || stopping || (maxCycles > 0 && cycleCount >= maxCycles)) {
    if (!stopping) log('completed', { completedCycles: cycleCount });
    return;
  }
  timer = setTimeout(loop, intervalMs);
};

log('started', { intervalMs, cycleTimeoutMs, maxCycles, runOnStart, runOnce, cycleScript });
await writeStatus({ status: 'RUNNING' });
await loop();

