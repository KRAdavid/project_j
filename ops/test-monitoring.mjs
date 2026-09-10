import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = 4182;
const cwd = fileURLToPath(new URL('../beta-app', import.meta.url));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd,
  env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', HEARTBEAT_INTERVAL_MS: '750' },
  stdio: 'ignore',
});

try {
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      healthy = response.ok;
      if (healthy) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true);
  const monitor = spawn(process.execPath, ['monitor-beta.mjs'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, MONITOR_BASE_URL: `http://127.0.0.1:${port}`, MONITOR_HEARTBEAT_TIMEOUT_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  monitor.stdout.on('data', (chunk) => { output += chunk.toString(); });
  monitor.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    // The monitor has its own 2s heartbeat budget. Allow process startup and
    // Windows child-process teardown headroom when this test runs after the
    // full sequential quality-gate suite.
    const timer = setTimeout(() => { monitor.kill(); reject(new Error('monitor가 제한시간 내 종료되지 않았습니다.')); }, 10000);
    monitor.once('error', reject);
    monitor.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0);
  assert.match(output, /"status":"OK"/);
  console.log('monitoring tests: PASS');
} finally {
  child.kill();
}

