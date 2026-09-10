import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

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

const addNotification = (notifications, notification) => {
  if (!notifications.some((item) => item.fingerprint === notification.fingerprint)) notifications.push(notification);
};

const notificationIdFor = (notification) => notification.notificationId
  || `NOTIFY-${createHash('sha256').update(String(notification.fingerprint || notification.title || 'UNKNOWN')).digest('hex').slice(0, 20)}`;

export const latestOperationalNotifications = (records = []) => {
  const latest = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const notificationId = notificationIdFor(record);
    latest.set(notificationId, { ...record, notificationId });
  }
  return [...latest.values()];
};

export class NotificationOutboxError extends Error {
  constructor(message, code = 'NOTIFICATION_OUTBOX_ERROR') {
    super(message);
    this.code = code;
  }
}

export const buildOperationalNotifications = ({ cycle = {}, review = {}, generatedAt = new Date().toISOString() } = {}) => {
  const notifications = [];
  const missing = Array.isArray(cycle.readiness?.missing) ? cycle.readiness.missing : [];
  const selectedTaskId = cycle.autopilot?.taskId || null;
  const monitorStatus = cycle.monitor?.status || 'UNKNOWN';

  if (monitorStatus !== 'OK') {
    addNotification(notifications, {
      schemaVersion: 'OPS-NOTIFICATION-0.1',
      notificationType: 'INCIDENT_HUMAN_REVIEW',
      severity: 'CRITICAL',
      fingerprint: `monitor:${monitorStatus}`,
      title: '운영 건강상태 이상 · 신규 거래 중지 검토 필요',
      message: `모니터링 상태가 ${monitorStatus}입니다. 원장·증거 상태를 확인하기 전까지 신규 체결을 허용하지 않습니다.`,
      requiredPrincipal: 'H-01',
      action: 'READ_ONLY_AND_INVESTIGATE',
      generatedAt,
    });
  }

  if (cycle.readiness?.decision !== 'GO') {
    addNotification(notifications, {
      schemaVersion: 'OPS-NOTIFICATION-0.1',
      notificationType: 'RELEASE_NO_GO',
      severity: 'CRITICAL',
      fingerprint: `readiness:${missing.join('|') || 'UNKNOWN'}`,
      title: '상용 전환 보류 · 필수 조건 미충족',
      message: `상용 전환 필수조건이 충족되지 않았습니다: ${missing.join(', ') || '상태 확인 필요'}.`,
      requiredPrincipal: 'H-01',
      action: 'HOLD_REAL_OPERATIONS',
      generatedAt,
    });
  }

  if (cycle.decision === 'HUMAN_REVIEW_REQUIRED' || cycle.decision === 'INCIDENT_HUMAN_REVIEW_REQUIRED') {
    addNotification(notifications, {
      schemaVersion: 'OPS-NOTIFICATION-0.1',
      notificationType: 'HUMAN_REVIEW_REQUIRED',
      severity: cycle.decision === 'INCIDENT_HUMAN_REVIEW_REQUIRED' ? 'CRITICAL' : 'HIGH',
      fingerprint: `review:${selectedTaskId || cycle.decision}`,
      title: 'H-01 승인 대기 업무가 생성됨',
      message: `자동운영 결과 ${selectedTaskId || '검토 대상'}에 대한 인간 결정이 필요합니다.`,
      requiredPrincipal: 'H-01',
      action: 'REVIEW_APPROVAL_INBOX',
      generatedAt,
    });
  }

  const staleCount = Number(review.approvals?.sla?.staleCount || 0);
  if (staleCount > 0) {
    addNotification(notifications, {
      schemaVersion: 'OPS-NOTIFICATION-0.1',
      notificationType: 'STALE_APPROVALS',
      severity: 'HIGH',
      fingerprint: `stale-approvals:${staleCount}`,
      title: '승인 SLA 초과 · H-01 검토 필요',
      message: `승인 대기 ${staleCount}건이 정해진 SLA를 초과했습니다. 자동 실행은 계속 보류합니다.`,
      requiredPrincipal: 'H-01',
      action: 'ESCALATE_H01_REVIEW',
      generatedAt,
    });
  }

  const staleTaskCount = Number(review.tasks?.sla?.staleCount || 0);
  if (staleTaskCount > 0) {
    addNotification(notifications, {
      schemaVersion: 'OPS-NOTIFICATION-0.1',
      notificationType: 'STALE_TASKS',
      severity: 'HIGH',
      fingerprint: `stale-tasks:${staleTaskCount}`,
      title: '업무 SLA 초과 · 담당 지원 및 H-01 검토 필요',
      message: `활성 업무 ${staleTaskCount}건이 정해진 SLA를 초과했습니다. AI는 담당 변경·기한 변경·실행 재개를 자동 처리하지 않습니다.`,
      requiredPrincipal: 'H-01',
      action: 'ESCALATE_AI01_AND_H01',
      generatedAt,
    });
  }

  return notifications;
};

export const appendOperationalNotifications = async (outboxPath, notifications = [], { generatedAt = new Date().toISOString() } = {}) => {
  if (!outboxPath) throw new Error('알림 대기함 저장 경로가 필요합니다.');
  if (!Array.isArray(notifications)) throw new Error('알림 목록 형식이 올바르지 않습니다.');
  const existingRaw = await readRecords(outboxPath);
  const existing = latestOperationalNotifications(existingRaw);
  const known = new Set(existing.filter((record) => record.state !== 'RESOLVED').map((record) => record.fingerprint));
  const additions = notifications
    .filter((notification) => notification?.fingerprint && !known.has(notification.fingerprint))
    .map((notification) => ({ ...clone(notification), notificationId: notificationIdFor(notification), state: 'PENDING', delivery: 'OUTBOX_ONLY', createdAt: notification.generatedAt || generatedAt }));
  if (additions.length) {
    await mkdir(dirname(outboxPath), { recursive: true });
    await appendFile(outboxPath, additions.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');
  }
  return {
    schemaVersion: 'OPS-NOTIFICATION-OUTBOX-0.1',
    generatedAt,
    delivery: 'OUTBOX_ONLY',
    externalNotificationSent: false,
    pendingCount: [...existing, ...additions].filter((record) => record.state === 'PENDING').length,
    addedCount: additions.length,
    additions: additions.map(clone),
    guardrail: '알림은 대기함에만 기록한다. 승인된 외부 채널 연결 전에는 외부 메시지를 자동 발송하지 않는다.',
  };
};

export const acknowledgeOperationalNotification = async (outboxPath, notificationId, { acknowledgedBy, acknowledgedAt = new Date().toISOString(), note = '' } = {}) => {
  if (!outboxPath) throw new NotificationOutboxError('알림 대기함 저장 경로가 필요합니다.', 'OUTBOX_PATH_REQUIRED');
  if (!acknowledgedBy) throw new NotificationOutboxError('알림 확인자 식별자가 필요합니다.', 'ACKNOWLEDGER_REQUIRED');
  const existingRaw = await readRecords(outboxPath);
  const latest = latestOperationalNotifications(existingRaw);
  const item = latest.find((record) => record.notificationId === notificationId || record.fingerprint === notificationId);
  if (!item) throw new NotificationOutboxError('알림을 찾을 수 없습니다.', 'NOTIFICATION_NOT_FOUND');
  if (item.state !== 'PENDING') {
    if (item.state === 'ACKNOWLEDGED' && item.acknowledgedBy === acknowledgedBy) return { record: item, idempotent: true };
    throw new NotificationOutboxError('이미 확인되었거나 종결된 알림은 다시 변경할 수 없습니다.', 'NOTIFICATION_ALREADY_ACKNOWLEDGED');
  }
  const record = {
    ...clone(item),
    notificationId: notificationIdFor(item),
    state: 'ACKNOWLEDGED',
    acknowledgedBy,
    acknowledgedAt,
    acknowledgmentNote: String(note || '').slice(0, 2000),
  };
  await mkdir(dirname(outboxPath), { recursive: true });
  await appendFile(outboxPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { record, idempotent: false };
};
