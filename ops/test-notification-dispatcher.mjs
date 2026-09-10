import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNotificationDeliveryRequest, dispatchPendingNotifications, requiresNotificationIncident } from './notification-dispatcher.mjs';

const root = await mkdtemp(join(tmpdir(), 'raw-material-notification-'));
const outboxPath = join(root, 'notification-outbox.jsonl');
const notification = {
  schemaVersion: 'OPS-NOTIFICATION-0.1', notificationId: 'NOTIFY-001', notificationType: 'RELEASE_NO_GO',
  severity: 'CRITICAL', fingerprint: 'readiness:R-01', title: '상용 전환 보류', message: '필수 조건 미충족',
  requiredPrincipal: 'H-01', action: 'HOLD_REAL_OPERATIONS', state: 'PENDING',
};
await writeFile(outboxPath, `${JSON.stringify(notification)}\n`, 'utf8');

const simulation = await dispatchPendingNotifications({ outboxPath, environment: 'simulation', enabled: true, webhookUrl: 'https://invalid.example' });
if (simulation.status !== 'OUTBOX_ONLY' || simulation.externalNotificationSent) throw new Error('시뮬레이션 외부 알림 차단 실패');
if (requiresNotificationIncident({ environment: 'simulation', status: 'BLOCKED' })) throw new Error('시뮬레이션 알림 차단을 사고로 잘못 승격');
if (!requiresNotificationIncident({ environment: 'staging', status: 'BLOCKED' }) || !requiresNotificationIncident({ environment: 'production', status: 'DELIVERY_FAILED' })) throw new Error('외부 알림 실패 사고 승격 누락');

const missingUrl = await dispatchPendingNotifications({ outboxPath, environment: 'staging', enabled: true });
if (missingUrl.status !== 'BLOCKED' || missingUrl.errorCode !== 'WEBHOOK_URL_REQUIRED') throw new Error('웹훅 URL 미설정 fail-closed 실패');
const insecureUrl = await dispatchPendingNotifications({ outboxPath, environment: 'staging', enabled: true, webhookUrl: 'http://alerts.example.test/hook' });
if (insecureUrl.status !== 'BLOCKED' || insecureUrl.errorCode !== 'WEBHOOK_HTTPS_REQUIRED') throw new Error('비보안 웹훅 차단 실패');
const credentialUrl = await dispatchPendingNotifications({ outboxPath, environment: 'staging', enabled: true, webhookUrl: 'https://user:pass@alerts.example.test/hook' });
if (credentialUrl.status !== 'BLOCKED' || credentialUrl.errorCode !== 'WEBHOOK_CREDENTIALS_FORBIDDEN') throw new Error('URL 내 웹훅 자격증명 차단 실패');

let calls = 0;
const sent = await dispatchPendingNotifications({
  outboxPath, environment: 'staging', enabled: true, webhookUrl: 'https://alerts.example.test/hook', bearerToken: 'test-token',
  fetchImpl: async (url, options) => {
    calls += 1;
    if (url !== 'https://alerts.example.test/hook') throw new Error('URL mismatch');
    const parsed = JSON.parse(options.body);
    if (options.headers.authorization !== 'Bearer test-token' || !options.headers['x-idempotency-key'] || parsed.notification.notificationId !== 'NOTIFY-001') throw new Error('delivery contract mismatch');
    return { ok: true, status: 202 };
  },
  now: new Date('2026-09-10T00:00:00.000Z'),
});
if (sent.status !== 'DELIVERED' || sent.sentCount !== 1 || calls !== 1 || !sent.externalNotificationSent) throw new Error('승인 채널 전송 실패');

const replay = await dispatchPendingNotifications({
  outboxPath, environment: 'staging', enabled: true, webhookUrl: 'https://alerts.example.test/hook',
  fetchImpl: async () => { calls += 1; return { ok: true, status: 202 }; },
});
if (replay.attemptedCount !== 0 || replay.sentCount !== 0 || calls !== 1) throw new Error('외부 알림 멱등 재실행 차단 실패');

const records = (await readFile(outboxPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
if (records.at(-1).deliveryStatus !== 'SENT' || !records.at(-1).deliveryId) throw new Error('append-only delivery evidence missing');
const request = buildNotificationDeliveryRequest(notification, { bearerToken: 'token', deliveryId: 'DELIVERY-TEST' });
if (request.headers.authorization !== 'Bearer token' || request.headers['x-idempotency-key'] !== 'DELIVERY-TEST') throw new Error('delivery header contract failed');

await rm(root, { recursive: true, force: true });
console.log('notification dispatcher tests: PASS');

