import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordMonitorObservation } from './incident-ledger.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-incident-rehearsal-'));
const ledgerPath = join(tempRoot, 'incident-ledger.jsonl');
const unreachableBase = 'http://127.0.0.1:45991';

const runMonitor = (baseUrl, heartbeatTimeoutMs = 300) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['ops/monitor-beta.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      MONITOR_BASE_URL: baseUrl,
      MONITOR_HEARTBEAT_TIMEOUT_MS: String(heartbeatTimeoutMs),
      MONITOR_INCIDENT_LEDGER_PATH: ledgerPath,
      MONITOR_REQUIRE_DAEMON: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`incident rehearsal monitor timeout: ${baseUrl}`));
  }, 8000);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
});

const waitForHealth = async (baseUrl) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`rehearsal server did not become healthy: ${baseUrl}`);
};

const parseLastJson = (output) => {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
};

try {
  const connectionFailure = await runMonitor(unreachableBase, 150);
  assert.equal(connectionFailure.code, 1);
  assert.equal(parseLastJson(connectionFailure.output).status, 'INCIDENT');

  const port = 4183;
  const slowServer = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../beta-app', import.meta.url)),
    env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', HEARTBEAT_INTERVAL_MS: '5000' },
    stdio: 'ignore',
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);
    const sseFailure = await runMonitor(baseUrl, 150);
    assert.equal(sseFailure.code, 1);
    const incident = parseLastJson(sseFailure.output);
    assert.equal(incident.status, 'INCIDENT');
    assert.match(incident.error, /heartbeat|SSE/i);
  } finally {
    if (slowServer.exitCode === null) slowServer.kill();
  }

  const recovery = await recordMonitorObservation({
    ledgerPath,
    status: 'OK',
    baseUrl: unreachableBase,
  });
  assert.ok(recovery.events.some((event) => event.eventType === 'INCIDENT_RECOVERED'));
  const records = (await readFile(ledgerPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.eventType === 'INCIDENT_OPENED'));
  assert.ok(records.some((record) => record.eventType === 'INCIDENT_RECOVERED'));
  console.log('incident rehearsal tests: PASS (connection, SSE, recovery)');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

