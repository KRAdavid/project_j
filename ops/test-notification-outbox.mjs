import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeOperationalNotification, appendOperationalNotifications, buildOperationalNotifications, latestOperationalNotifications } from './notification-outbox.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'raw-material-notification-'));
try {
  const cycle = {
    decision: 'HUMAN_REVIEW_REQUIRED',
    monitor: { status: 'OK' },
    readiness: { decision: 'NO_GO', missing: ['R-01', 'R-05'] },
    autopilot: { taskId: 'TASK-AUTO-01' },
  };
  const review = { approvals: { sla: { staleCount: 2 } }, tasks: { sla: { staleCount: 1 } } };
  const notifications = buildOperationalNotifications({ cycle, review, generatedAt: '2026-09-10T00:00:00.000Z' });
  if (notifications.length !== 4) throw new Error(`알림 생성 수가 예상과 다릅니다: ${notifications.length}`);
  const outboxPath = join(tempRoot, 'notification-outbox.jsonl');
  const first = await appendOperationalNotifications(outboxPath, notifications, { generatedAt: '2026-09-10T00:00:00.000Z' });
  if (first.addedCount !== 4 || first.externalNotificationSent !== false) throw new Error('첫 알림 기록 결과가 올바르지 않습니다.');
  const second = await appendOperationalNotifications(outboxPath, notifications, { generatedAt: '2026-09-10T00:01:00.000Z' });
  if (second.addedCount !== 0 || second.pendingCount !== 4) throw new Error('동일 알림 중복 방지가 동작하지 않습니다.');
  const records = (await readFile(outboxPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  if (records.some((record) => record.delivery !== 'OUTBOX_ONLY' || record.state !== 'PENDING')) throw new Error('알림 대기함 상태가 안전하지 않습니다.');
  const targetId = records[0].notificationId;
  const acknowledged = await acknowledgeOperationalNotification(outboxPath, targetId, { acknowledgedBy: 'H-01', note: '운영자가 확인하고 후속 검토를 시작함' });
  if (acknowledged.idempotent || acknowledged.record.state !== 'ACKNOWLEDGED') throw new Error('알림 확인 상태가 기록되지 않았습니다.');
  const repeated = await acknowledgeOperationalNotification(outboxPath, targetId, { acknowledgedBy: 'H-01' });
  if (!repeated.idempotent || latestOperationalNotifications((await readFile(outboxPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line))).find((record) => record.notificationId === targetId)?.state !== 'ACKNOWLEDGED') throw new Error('알림 확인 재시도가 멱등적이지 않습니다.');
  await expectFailure(() => acknowledgeOperationalNotification(outboxPath, targetId, { acknowledgedBy: 'AI-01' }), 'NOTIFICATION_ALREADY_ACKNOWLEDGED');
  console.log('notification outbox tests: PASS');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function expectFailure(action, code) {
  try {
    await action();
    throw new Error(`예상한 실패가 발생하지 않았습니다: ${code}`);
  } catch (error) {
    if (error.code !== code) throw error;
  }
}

