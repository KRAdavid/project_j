import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { latestOperationalNotifications, NotificationOutboxError } from './notification-outbox.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

const readRecords = async (outboxPath) => {
  try {
    const raw = await readFile(outboxPath, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const deliveryIdFor = (notification) => `DELIVERY-${createHash('sha256')
  .update(String(notification.notificationId || notification.fingerprint || 'UNKNOWN'))
  .digest('hex').slice(0, 20)}`;

export const requiresNotificationIncident = ({ environment = 'simulation', status = '' } = {}) => (
  environment !== 'simulation' && ['BLOCKED', 'DELIVERY_FAILED', 'PARTIAL_FAILURE'].includes(status)
);

export const buildNotificationDeliveryRequest = (notification, { bearerToken = '', deliveryId = deliveryIdFor(notification) } = {}) => {
  if (!notification?.notificationId && !notification?.fingerprint) {
    throw new NotificationOutboxError('전송할 알림 식별자가 필요합니다.', 'NOTIFICATION_ID_REQUIRED');
  }
  const payload = {
    schemaVersion: 'OPS-NOTIFICATION-WEBHOOK-0.1',
    deliveryId,
    notification: clone(notification),
  };
  const headers = {
    'content-type': 'application/json',
    'x-idempotency-key': deliveryId,
  };
  if (String(bearerToken).trim()) headers.authorization = `Bearer ${String(bearerToken).trim()}`;
  return { payload, headers };
};

const validateWebhookUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:') return { valid: false, errorCode: 'WEBHOOK_HTTPS_REQUIRED' };
    if (parsed.username || parsed.password) return { valid: false, errorCode: 'WEBHOOK_CREDENTIALS_FORBIDDEN' };
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, errorCode: 'WEBHOOK_URL_INVALID' };
  }
};

const appendDeliveryRecord = async (outboxPath, item, patch) => {
  await mkdir(dirname(outboxPath), { recursive: true });
  const record = { ...clone(item), ...patch };
  await appendFile(outboxPath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
};

/** Deliver only through an explicitly enabled and configured channel. */
export const dispatchPendingNotifications = async ({
  outboxPath,
  environment = process.env.APP_ENV || 'simulation',
  enabled = process.env.OPS_EXTERNAL_NOTIFICATIONS_ENABLED === 'true',
  webhookUrl = process.env.OPS_NOTIFICATION_WEBHOOK_URL || '',
  bearerToken = process.env.OPS_NOTIFICATION_WEBHOOK_TOKEN || '',
  fetchImpl = globalThis.fetch,
  now = new Date(),
  maxItems = 20,
} = {}) => {
  if (!outboxPath) throw new NotificationOutboxError('알림 대기함 저장 경로가 필요합니다.', 'OUTBOX_PATH_REQUIRED');
  const records = latestOperationalNotifications(await readRecords(outboxPath));
  const pending = records.filter((record) => record.state === 'PENDING' && record.deliveryStatus !== 'SENT').slice(0, Math.max(0, Number(maxItems) || 0));
  const base = {
    schemaVersion: 'OPS-NOTIFICATION-DISPATCH-0.1',
    environment,
    attemptedCount: pending.length,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    externalNotificationSent: false,
  };

  if (environment === 'simulation' || !enabled) {
    return { ...base, status: 'OUTBOX_ONLY', skippedCount: pending.length, guardrail: '시뮬레이션 또는 명시적 외부 알림 활성화 전에는 외부 채널로 전송하지 않습니다.' };
  }
  if (!webhookUrl) return { ...base, status: 'BLOCKED', skippedCount: pending.length, errorCode: 'WEBHOOK_URL_REQUIRED' };
  const webhook = validateWebhookUrl(webhookUrl);
  if (!webhook.valid) return { ...base, status: 'BLOCKED', skippedCount: pending.length, errorCode: webhook.errorCode };
  if (typeof fetchImpl !== 'function') return { ...base, status: 'BLOCKED', skippedCount: pending.length, errorCode: 'FETCH_UNAVAILABLE' };

  const results = [];
  for (const item of pending) {
    const deliveryId = deliveryIdFor(item);
    const request = buildNotificationDeliveryRequest(item, { bearerToken, deliveryId });
    try {
      const response = await fetchImpl(webhook.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.payload) });
      if (!response?.ok) {
        const failed = await appendDeliveryRecord(outboxPath, item, { deliveryStatus: 'FAILED', deliveryId, deliveryAttemptedAt: now.toISOString(), deliveryError: `HTTP_${response?.status || 'UNKNOWN'}` });
        results.push({ notificationId: item.notificationId, status: 'FAILED', record: failed });
        base.failedCount += 1;
        continue;
      }
      const sent = await appendDeliveryRecord(outboxPath, item, { deliveryStatus: 'SENT', deliveryId, deliveredAt: now.toISOString(), deliveryError: null });
      results.push({ notificationId: item.notificationId, status: 'SENT', record: sent });
      base.sentCount += 1;
    } catch (error) {
      const failed = await appendDeliveryRecord(outboxPath, item, { deliveryStatus: 'FAILED', deliveryId, deliveryAttemptedAt: now.toISOString(), deliveryError: String(error.message || error).slice(0, 500) });
      results.push({ notificationId: item.notificationId, status: 'FAILED', record: failed });
      base.failedCount += 1;
    }
  }
  return {
    ...base,
    status: base.failedCount ? (base.sentCount ? 'PARTIAL_FAILURE' : 'DELIVERY_FAILED') : 'DELIVERED',
    externalNotificationSent: base.sentCount > 0,
    results,
    guardrail: '외부 전송은 명시적으로 활성화된 승인 채널에 한정하며, 알림 확인·거래 승인·분쟁 종결을 자동 처리하지 않습니다.',
  };
};

