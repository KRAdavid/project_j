import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = 4180;
const cwd = fileURLToPath(new URL('.', import.meta.url));
const child = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', HEARTBEAT_INTERVAL_MS: '50', ALLOW_TEST_SHUTDOWN: 'true' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
try {
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { response = await fetch(`${base}/api/events`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.equal(response?.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 3000;
  while (!text.includes('event: heartbeat') && Date.now() < deadline) {
    const result = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: true }), 500))]);
    if (result.done) break;
    text += decoder.decode(result.value);
  }
  assert.match(text, /event: heartbeat/);
  await reader.cancel();
  console.log('sse heartbeat tests: PASS');
} finally {
  try { await fetch(`${base}/api/test/shutdown`, { method: 'POST' }); } catch {}
  if (child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (child.exitCode === null) child.kill();
  }
}
