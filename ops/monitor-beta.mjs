import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultIncidentLedgerPath, recordMonitorObservation } from './incident-ledger.mjs';
import { evaluateDaemonLiveness } from './daemon-liveness.mjs';

const baseUrl = (process.env.MONITOR_BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const heartbeatTimeoutMs = Number(process.env.MONITOR_HEARTBEAT_TIMEOUT_MS || 20000);
const incidentLedgerPath = process.env.MONITOR_INCIDENT_LEDGER_PATH || defaultIncidentLedgerPath;
const daemonStatusPath = process.env.MONITOR_DAEMON_STATUS_PATH || resolve(fileURLToPath(new URL('daemon-status.json', import.meta.url)));
const daemonRequired = process.env.MONITOR_REQUIRE_DAEMON === 'true';
const daemonMaxAgeMs = Number(process.env.MONITOR_DAEMON_MAX_AGE_MS || 20 * 60 * 1000);
const supervisorStatusPath = process.env.MONITOR_SUPERVISOR_STATUS_PATH || resolve(fileURLToPath(new URL('company-supervisor-status.json', import.meta.url)));
const supervisorRequired = process.env.MONITOR_REQUIRE_SUPERVISOR === 'true';
const supervisorMaxAgeMs = Number(process.env.MONITOR_SUPERVISOR_MAX_AGE_MS || 2 * 60 * 1000);

const readHealth = async () => {
  const response = await fetch(`${baseUrl}/api/health`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`health 응답 코드 ${response.status}`);
  const health = await response.json();
  if (health.eventStream !== 'SSE') throw new Error('실시간 이벤트 스트림이 SSE가 아닙니다.');
  if (!health.persistence?.failClosed) throw new Error('영속성 장애 시 fail-closed가 활성화되어 있지 않습니다.');
  return health;
};

const readHeartbeat = async () => {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`SSE 응답 코드 ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const readUntilHeartbeat = async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) return false;
      received += decoder.decode(result.value);
      if (received.includes('event: heartbeat')) return true;
    }
  };
  let timeoutId;
  try {
    const timedOut = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('SSE heartbeat timeout')), heartbeatTimeoutMs);
    });
    try {
      const receivedHeartbeat = await Promise.race([readUntilHeartbeat(), timedOut]);
      if (receivedHeartbeat) return { received: true };
    } catch (error) {
      if (error.message === 'SSE heartbeat timeout') throw new Error(`SSE heartbeat가 ${heartbeatTimeoutMs}ms 내에 도착하지 않았습니다.`);
      throw error;
    }
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
    reader.cancel().catch(() => {});
  }
  throw new Error(`SSE heartbeat가 ${heartbeatTimeoutMs}ms 내에 도착하지 않았습니다.`);
};

const readDaemonLiveness = async () => {
  if (!daemonRequired) return { required: false, ready: true, status: 'OPTIONAL' };
  const status = JSON.parse(await readFile(daemonStatusPath, 'utf8'));
  let processAlive = false;
  if (Number.isInteger(status?.pid) && status.pid > 0) {
    try { process.kill(status.pid, 0); processAlive = true; } catch { processAlive = false; }
  }
  const result = evaluateDaemonLiveness(status, { maxAgeMs: daemonMaxAgeMs, processAlive });
  if (!result.ready) throw new Error(`운영 데몬 생존 상태가 유효하지 않습니다: ${result.reason}`);
  return { required: true, ...result };
};

const readSupervisorLiveness = async () => {
  if (!supervisorRequired) return { required: false, ready: true, status: 'OPTIONAL' };
  const status = JSON.parse(String(await readFile(supervisorStatusPath, 'utf8')).replace(/^\uFEFF/, ''));
  let processAlive = false;
  if (Number.isInteger(status?.pid) && status.pid > 0) {
    try { process.kill(status.pid, 0); processAlive = true; } catch { processAlive = false; }
  }
  const result = evaluateDaemonLiveness(status, { maxAgeMs: supervisorMaxAgeMs, processAlive });
  if (!result.ready) throw new Error(`회사 운영 감독자 생존 상태가 유효하지 않습니다: ${result.reason}`);
  return { required: true, ...result };
};

try {
  const health = await readHealth();
  await readHeartbeat();
  const daemon = await readDaemonLiveness();
  const supervisor = await readSupervisorLiveness();
  const checkedAt = new Date().toISOString();
  const incidentLedger = await recordMonitorObservation({ ledgerPath: incidentLedgerPath, status: 'OK', baseUrl, checkedAt });
  console.log(JSON.stringify({ status: 'OK', baseUrl, runtimeMode: health.persistence.runtimeMode, checkedAt, daemon, supervisor, incidentLedger }));
} catch (error) {
  const checkedAt = new Date().toISOString();
  let incidentLedger = null;
  try {
    incidentLedger = await recordMonitorObservation({ ledgerPath: incidentLedgerPath, status: 'INCIDENT', baseUrl, error: error.message, checkedAt });
  } catch (ledgerError) {
    incidentLedger = { status: 'LEDGER_WRITE_FAILED', error: ledgerError.message, humanEscalation: 'H-01' };
  }
  console.error(JSON.stringify({ status: 'INCIDENT', baseUrl, error: error.message, checkedAt, incidentLedger }));
  process.exitCode = 1;
}

