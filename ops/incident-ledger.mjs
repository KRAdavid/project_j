import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultIncidentLedgerPath = resolve(fileURLToPath(new URL('incident-ledger.jsonl', import.meta.url)));

const stableFingerprint = ({ baseUrl = '', error = '', check = 'monitor' } = {}) => `monitor:${createHash('sha256')
  .update(JSON.stringify({ baseUrl, error, check }))
  .digest('hex')
  .slice(0, 24)}`;

const readRecords = async (ledgerPath) => {
  try {
    return (await readFile(ledgerPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const appendRecord = async (ledgerPath, record) => {
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
};

export const recordMonitorObservation = async ({
  ledgerPath = defaultIncidentLedgerPath,
  status,
  baseUrl,
  error = null,
  checkedAt = new Date().toISOString(),
  check = 'monitor',
} = {}) => {
  if (!['OK', 'INCIDENT'].includes(status)) throw new Error('모니터링 상태는 OK 또는 INCIDENT여야 합니다.');
  const records = await readRecords(ledgerPath);
  const latest = new Map();
  for (const record of records) if (record.fingerprint) latest.set(record.fingerprint, record);
  const events = [];
  if (status === 'INCIDENT') {
    const fingerprint = stableFingerprint({ baseUrl, error, check });
    const prior = latest.get(fingerprint);
    const eventType = prior?.state === 'OPEN' ? 'INCIDENT_REOBSERVED' : 'INCIDENT_OPENED';
    events.push(await appendRecord(ledgerPath, {
      schemaVersion: 'INCIDENT-LEDGER-0.1',
      eventId: `MONITOR-EVENT-${createHash('sha256').update(`${fingerprint}:${checkedAt}:${eventType}`).digest('hex').slice(0, 20)}`,
      eventType,
      state: 'OPEN',
      fingerprint,
      baseUrl,
      check,
      error,
      checkedAt,
      humanEscalation: 'H-01',
      alertAction: eventType === 'INCIDENT_OPENED' ? 'ESCALATE_H01' : 'SUPPRESS_DUPLICATE',
      automationRule: '거래 API 재개·계약·결제·분쟁 종결 자동 승인 금지',
    }));
  } else {
    const open = [...latest.values()].filter((record) => record.state === 'OPEN' && record.baseUrl === baseUrl);
    for (const prior of open) {
      events.push(await appendRecord(ledgerPath, {
        schemaVersion: 'INCIDENT-LEDGER-0.1',
        eventId: `MONITOR-EVENT-${createHash('sha256').update(`${prior.fingerprint}:${checkedAt}:RECOVERED`).digest('hex').slice(0, 20)}`,
        eventType: 'INCIDENT_RECOVERED',
        state: 'RECOVERED',
        fingerprint: prior.fingerprint,
        baseUrl,
        check: prior.check,
        recoveredAt: checkedAt,
        humanEscalation: 'H-01',
        alertAction: 'RETAIN_FOR_REVIEW',
      }));
    }
    events.push(await appendRecord(ledgerPath, {
      schemaVersion: 'INCIDENT-LEDGER-0.1',
      eventId: `MONITOR-EVENT-${createHash('sha256').update(`${baseUrl}:${checkedAt}:HEALTHY`).digest('hex').slice(0, 20)}`,
      eventType: 'MONITOR_HEALTHY',
      state: 'HEALTHY',
      fingerprint: `monitor:healthy:${createHash('sha256').update(baseUrl).digest('hex').slice(0, 16)}`,
      baseUrl,
      check,
      checkedAt,
      recoveredIncidentCount: open.length,
    }));
  }
  return {
    ledgerPath,
    status,
    events: events.map(({ eventId, eventType, state, alertAction }) => ({ eventId, eventType, state, alertAction })),
    pendingHumanEscalation: events.some((event) => event.state === 'OPEN' && event.alertAction === 'ESCALATE_H01'),
  };
};

export { stableFingerprint };

