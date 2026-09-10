import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordMonitorObservation } from './incident-ledger.mjs';

const root = await mkdtemp(join(tmpdir(), 'raw-material-incident-ledger-'));
const ledgerPath = join(root, 'incident-ledger.jsonl');
try {
  const first = await recordMonitorObservation({ ledgerPath, status: 'INCIDENT', baseUrl: 'http://127.0.0.1:4173', error: 'fetch failed', checkedAt: '2026-09-09T10:00:00.000Z' });
  assert.equal(first.pendingHumanEscalation, true);
  assert.equal(first.events[0].eventType, 'INCIDENT_OPENED');
  const repeated = await recordMonitorObservation({ ledgerPath, status: 'INCIDENT', baseUrl: 'http://127.0.0.1:4173', error: 'fetch failed', checkedAt: '2026-09-09T10:01:00.000Z' });
  assert.equal(repeated.pendingHumanEscalation, false);
  assert.equal(repeated.events[0].eventType, 'INCIDENT_REOBSERVED');
  const recovered = await recordMonitorObservation({ ledgerPath, status: 'OK', baseUrl: 'http://127.0.0.1:4173', checkedAt: '2026-09-09T10:02:00.000Z' });
  assert.equal(recovered.events.some((event) => event.eventType === 'INCIDENT_RECOVERED'), true);
  const records = (await readFile(ledgerPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.eventType), ['INCIDENT_OPENED', 'INCIDENT_REOBSERVED', 'INCIDENT_RECOVERED', 'MONITOR_HEALTHY']);
  console.log('incident ledger tests: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}

