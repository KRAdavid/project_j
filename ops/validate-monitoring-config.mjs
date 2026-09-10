import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(await readFile(resolve(root, 'ops/monitoring-config.json'), 'utf8'));
if (!Array.isArray(config.checks) || config.checks.length < 3) throw new Error('모니터링 체크가 부족합니다.');
if (!config.checks.some((check) => check.id === 'M-04' && check.name === 'ops_daemon_liveness' && check.severity === 'critical')) throw new Error('운영 데몬 생존 모니터링 체크가 없습니다.');
if (!config.checks.some((check) => check.id === 'M-05' && check.name === 'company_supervisor_liveness' && check.severity === 'critical')) throw new Error('회사 운영 감독자 생존 모니터링 체크가 없습니다.');
for (const check of config.checks) {
  if (!check.id || !check.name || !check.severity) throw new Error('모니터링 체크 정의가 불완전합니다.');
}
if (!/INCIDENT/.test(config.incidentRule) || config.humanEscalation !== 'H-01') throw new Error('모니터링 사고 승격 정책이 없습니다.');
const livenessSource = await readFile(resolve(root, 'ops/daemon-liveness.mjs'), 'utf8');
if (!livenessSource.includes('DAEMON_LAST_CYCLE_FAILED') || !livenessSource.includes('DAEMON_LAST_CYCLE_TIMED_OUT') || !livenessSource.includes('DAEMON_PROCESS_NOT_ALIVE') || !livenessSource.includes('processAlive')) throw new Error('데몬 마지막 사이클·프로세스 생존 승격 정책이 없습니다.');
const monitorSource = await readFile(resolve(root, 'ops/monitor-beta.mjs'), 'utf8');
if (!monitorSource.includes('process.kill(status.pid, 0)') || !monitorSource.includes('processAlive')) throw new Error('모니터가 데몬 PID 실제 생존을 확인하지 않습니다.');
if (!monitorSource.includes('MONITOR_REQUIRE_SUPERVISOR') || !monitorSource.includes('readSupervisorLiveness') || !monitorSource.includes('supervisorMaxAgeMs')) throw new Error('모니터가 회사 운영 감독자 생존을 확인하지 않습니다.');
if (config.incidentLedger?.format !== 'append-only-jsonl' || config.incidentLedger?.deduplicateBy !== 'endpoint-check-error-fingerprint' || config.incidentLedger?.externalAlertRequiredForRelease !== true) throw new Error('사고 원장·중복 경보·외부 알림 게이트가 불완전합니다.');
console.log('monitoring config tests: PASS');

