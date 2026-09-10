import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const port = 4178;
const cwd = fileURLToPath(new URL('.', import.meta.url));
const child = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, PORT: String(port), APP_ENV: 'simulation', PERSISTENCE_MODE: 'memory' }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
try {
  let response;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      response = await fetch(`${base}/api/market-board?specId=GABA-SPEC-001`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(response?.status, 200);
  const board = await response.json();
  assert.equal(board.schemaVersion, 'SERVER-VERIFIED-MARKET-BOARD-0.1');
  assert.equal(board.dataStatus, 'SERVER_VERIFIED_OFFERS');
  assert.deepEqual(board.asks.map((offer) => offer.lotId), ['GBA-KR-2407']);
  assert.equal(board.asks[0].evidenceStatus, 'PRETRADE_VERIFIED');
  assert.equal(board.asks[0].availableQty, 1200);
  assert.equal('supplierOrganizationId' in board.asks[0], false);
  assert.deepEqual(board.bids, []);
  const otherSpec = await fetch(`${base}/api/market-board?specId=UNKNOWN-SPEC`);
  assert.equal(otherSpec.status, 200);
  assert.equal((await otherSpec.json()).dataStatus, 'NO_VERIFIED_OFFERS');
  console.log('market board API tests: PASS');
} finally {
  child.kill();
}

