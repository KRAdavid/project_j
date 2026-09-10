import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { evaluateTaskSla } from './task-sla.mjs';
import { parseOperationalTimestamp } from './operational-time.mjs';

const TRIGGER_DEFINITIONS = {
  QUALITY_GATE_FAILED: {
    risk: 'critical',
    ownerAi: 'AI-10 아틀라스',
    reviewers: ['AI-11 실드', 'AI-12 리콘'],
    objective: '품질 게이트 실패 원인을 조사하고 영향 범위와 거래 중단 여부를 결정한다.',
    nextAction: '실패 로그·재현 절차·영향 거래를 확인하고 H-01에 중단 또는 수정안을 보고한다.',
  },
  EVIDENCE_GAP: {
    risk: 'critical',
    ownerAi: 'AI-07 큐비',
    reviewers: ['AI-04 원료나', 'AI-11 실드'],
    objective: '거래 전 검증에 필요한 증거 공백을 해소하고 해당 기능의 공개 가능 여부를 재평가한다.',
    nextAction: '누락 증거의 원문·해시·유효기간·검토자를 확보하기 전까지 해당 거래 경로를 보류한다.',
  },
  READINESS_NO_GO: {
    risk: 'critical',
    ownerAi: 'AI-01 세온',
    reviewers: ['AI-10 아틀라스', 'AI-11 실드'],
    objective: '상용 전환 필수조건 미충족 항목의 해결 순서와 인간 승인 기준을 확정한다.',
    nextAction: '누락된 릴리스 체크를 담당 AI에게 배정하고 증거가 확보될 때까지 공개·실거래를 차단한다.',
  },
  MONITOR_INCIDENT: {
    risk: 'critical',
    ownerAi: 'AI-02 오퍼라',
    reviewers: ['AI-10 아틀라스', 'AI-11 실드'],
    objective: '서비스 모니터링 사고를 분류하고 거래 API의 안전한 중단·복구 절차를 실행한다.',
    nextAction: '읽기 전용 전환, 원인 로그 보존, 복구 검증 후 H-01에게 재개 승인을 요청한다.',
  },
  TASK_METADATA_GAP: {
    risk: 'critical',
    ownerAi: 'AI-01 세온',
    reviewers: ['AI-10 아틀라스', 'AI-12 리콘'],
    objective: '활성 업무의 생성·인수·검토 시각을 보완해 책임과 SLA를 재현 가능하게 만든다.',
    nextAction: '활성 업무의 원문과 인수·검토 시각을 확인하고, 메타데이터가 완성될 때까지 해당 자동 업무의 완료 처리를 보류한다.',
  },
  TASK_SLA_BREACH: {
    risk: 'critical',
    ownerAi: 'AI-01 세온',
    reviewers: ['AI-12 리콘', 'AI-11 실드'],
    objective: 'SLA를 초과한 업무의 원인·의존성·담당자 지원 필요성을 분류하고 H-01에 상향보고한다.',
    nextAction: '지연 원인과 차단 의존성을 기록하고, 담당 변경·기한 조정·중단 중 하나를 H-01에게 요청한다.',
  },
};

const evidenceRouting = {
  'postgres-integration': { ownerAi: 'AI-10 아틀라스', reviewers: ['AI-11 실드', 'AI-12 리콘'] },
  'server-persistence-recovery': { ownerAi: 'AI-10 아틀라스', reviewers: ['AI-11 실드', 'AI-12 리콘'] },
  'price-feed': { ownerAi: 'AI-05 트렌디', reviewers: ['AI-04 원료나', 'AI-11 실드'] },
  'price-index': { ownerAi: 'AI-05 트렌디', reviewers: ['AI-04 원료나', 'AI-11 실드'] },
  'material-master': { ownerAi: 'AI-04 원료나', reviewers: ['AI-07 큐비', 'AI-09 콘트라'] },
};

const fingerprintFor = (key, value) => `${key}:${String(value || 'unknown').trim().replace(/\s+/g, '_')}`;

export const deriveOperationalSignals = ({ evidence = [], readiness = null, monitor = null } = {}) => {
  const signals = [];
  for (const item of evidence) {
    if (!item?.passed && !item?.skipped) {
      signals.push({
        triggerKey: 'QUALITY_GATE_FAILED',
        fingerprint: fingerprintFor('quality', item.name),
        source: item.name,
        context: item.output || '품질 게이트 실패',
      });
    }
    if (item?.skipped) {
      const routing = evidenceRouting[item.name] || {};
      signals.push({
        triggerKey: 'EVIDENCE_GAP',
        fingerprint: fingerprintFor('evidence', item.name),
        source: item.name,
        context: item.output || '검증이 실행되지 않음',
        ownerAi: routing.ownerAi,
        reviewers: routing.reviewers,
      });
    }
  }
  if (readiness?.decision === 'NO_GO') {
    const missing = Array.isArray(readiness.missing) ? readiness.missing : [];
    signals.push({
      triggerKey: 'READINESS_NO_GO',
      fingerprint: fingerprintFor('readiness', missing.join('|') || 'unknown'),
      source: 'release-readiness',
      context: missing.length ? `미충족 체크: ${missing.join(', ')}` : '상용 전환 불가',
    });
  }
  if (monitor?.status === 'INCIDENT') {
    signals.push({
      triggerKey: 'MONITOR_INCIDENT',
      fingerprint: fingerprintFor('monitor', monitor.error || monitor.code || 'unknown'),
      source: 'monitor-beta',
      context: monitor.error || '모니터링 사고',
    });
  }
  return signals;
};

const isValidTimestamp = (value) => Number.isFinite(parseOperationalTimestamp(value));

const nextLifecycleTimestamp = (task, candidate) => {
  const candidateMs = parseOperationalTimestamp(candidate);
  const lifecycleMs = ['createdAt', 'enqueuedAt', 'claimedAt', 'startedAt', 'reviewedAt', 'updatedAt', 'lastRecheckedAt', 'resolvedAt']
    .map((field) => parseOperationalTimestamp(task?.[field]))
    .filter(Number.isFinite);
  const baseMs = Number.isFinite(candidateMs) ? candidateMs : Date.now();
  return new Date(Math.max(baseMs, ...lifecycleMs, 0) + 1).toISOString();
};

export const deriveTaskMetadataSignals = ({ taskQueue = null } = {}) => {
  const tasks = Array.isArray(taskQueue?.tasks) ? taskQueue.tasks : [];
  const activeTasks = tasks.filter((task) => ['queued', 'working', 'review'].includes(task?.status));
  const gaps = activeTasks.filter((task) => (
    !isValidTimestamp(task.createdAt)
    || (['working', 'review'].includes(task.status) && !isValidTimestamp(task.claimedAt))
  ));
  if (!gaps.length) return [];
  const ids = gaps.map((task) => task.id).filter(Boolean).sort();
  return [{
    triggerKey: 'TASK_METADATA_GAP',
    fingerprint: fingerprintFor('task-metadata', ids.join('|')),
    source: 'task-queue',
    context: `활성 업무 ${gaps.length}건에 생성·인수 시각 공백이 있습니다: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ' 외' : ''}`,
  }];
};

export const deriveTaskSlaSignals = ({ taskQueue = null, now = new Date(), slaHours } = {}) => {
  const evaluation = evaluateTaskSla({ tasks: taskQueue?.tasks, now, slaHours });
  const breaches = evaluation.items.filter((item) => item.stale);
  if (!breaches.length) return [];
  const ids = breaches.map((item) => item.taskId).filter(Boolean).sort();
  const summary = breaches
    .slice()
    .sort((left, right) => (right.ageHours || 0) - (left.ageHours || 0))
    .slice(0, 8)
    .map((item) => `${item.taskId}(${item.status},${item.ageHours}h/${item.thresholdHours}h)`)
    .join(', ');
  return [{
    triggerKey: 'TASK_SLA_BREACH',
    fingerprint: fingerprintFor('task-sla', ids.join('|')),
    source: 'task-queue-sla',
    context: `SLA 초과 업무 ${breaches.length}건: ${summary}${ids.length > 8 ? ' 외' : ''}`,
  }];
};

export const buildTriggerTasks = ({ signals = [], generatedAt = new Date().toISOString() } = {}) => signals
  .filter((signal) => TRIGGER_DEFINITIONS[signal.triggerKey])
  .map((signal) => {
    const definition = TRIGGER_DEFINITIONS[signal.triggerKey];
    const safeFingerprint = signal.fingerprint.replace(/[^a-zA-Z0-9:_-]/g, '_');
    return {
      id: `AUTO-${signal.triggerKey}-${safeFingerprint}`,
      triggerKey: signal.triggerKey,
      fingerprint: signal.fingerprint,
      objective: definition.objective,
      whyNow: signal.context,
      scope: `원인·영향·완화책 조사 (${signal.source})`,
      outOfScope: 'H-01 승인 전 실제 거래·계약·결제·운영 재개',
      ownerAi: signal.ownerAi || definition.ownerAi,
      reviewers: signal.reviewers || definition.reviewers,
      inputs: [signal.source],
      output: '증거가 포함된 검토 패킷과 H-01 결정안',
      risk: definition.risk,
      humanGate: 'approval',
      status: 'queued',
      evidence: [signal.source],
      nextAction: definition.nextAction,
      createdAt: generatedAt,
      source: 'automatic-trigger-engine',
    };
  });

const readInbox = async (inboxPath) => {
  try {
    return JSON.parse(await readFile(inboxPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 'TRIGGER-INBOX-0.1', tasks: [] };
    throw error;
  }
};

export const upsertTriggerInbox = async (inboxPath, tasks, { generatedAt = new Date().toISOString() } = {}) => {
  if (!inboxPath) throw new Error('자동 트리거 대기열 경로가 필요합니다.');
  await mkdir(dirname(inboxPath), { recursive: true });
  const existing = await readInbox(inboxPath);
  const prior = Array.isArray(existing.tasks) ? existing.tasks : [];
  const activeFingerprints = new Set(prior.filter((task) => !['done', 'rejected', 'resolved'].includes(task.status)).map((task) => task.fingerprint));
  const currentFingerprints = new Set(tasks.map((task) => task.fingerprint));
  const additions = tasks.filter((task) => !activeFingerprints.has(task.fingerprint));
  const refreshed = prior.map((task) => {
    const latest = tasks.find((candidate) => candidate.fingerprint === task.fingerprint);
    if (!latest || ['done', 'rejected', 'resolved'].includes(task.status)) return task;
    return {
      ...task,
      ownerAi: latest.ownerAi,
      reviewers: latest.reviewers,
      whyNow: latest.whyNow,
      nextAction: latest.nextAction,
      lastRecheckedAt: generatedAt,
      lastRecheckResult: currentFingerprints.has(task.fingerprint) ? 'ACTIVE_SIGNAL' : 'NOT_DETECTED',
      updatedAt: generatedAt,
    };
  });
  const merged = refreshed.map((task) => (
    !currentFingerprints.has(task.fingerprint) && !['done', 'rejected', 'resolved'].includes(task.status)
      ? { ...task, lastRecheckedAt: generatedAt, lastRecheckResult: 'NOT_DETECTED', updatedAt: generatedAt }
      : task
  ));
  merged.push(...additions);
  const activePending = merged.filter((task) => !['done', 'rejected', 'resolved'].includes(task.status) && currentFingerprints.has(task.fingerprint));
  const auditOnly = merged.filter((task) => !['done', 'rejected', 'resolved'].includes(task.status) && !currentFingerprints.has(task.fingerprint));
  const inbox = {
    schemaVersion: 'TRIGGER-INBOX-0.1',
    generatedAt,
    status: activePending.length ? 'PENDING' : auditOnly.length ? 'AUDIT_ONLY' : 'CLEAR',
    pending: activePending.length,
    auditOnlyPending: auditOnly.length,
    tasks: merged,
    guardrail: '자동 생성 업무는 H-01 승인 전 실제 거래·계약·결제·운영 재개를 수행하지 않는다.',
  };
  await writeFile(inboxPath, `${JSON.stringify(inbox, null, 2)}\n`, 'utf8');
  return { inbox, additions };
};

/**
 * Return only tasks backed by a signal in the current evidence packet.
 * Revalidated-but-cleared inbox entries remain visible for H-01 audit, but
 * must never be re-enqueued as active work.
 */
export const selectActiveTriggerTasks = ({ currentTasks = [], inbox = {} } = {}) => currentTasks
  .map((task) => inbox.tasks?.find((candidate) => candidate.fingerprint === task.fingerprint) || task)
  .filter((task) => !['done', 'rejected', 'resolved', 'approved'].includes(task.status));

export const enqueueTriggerTasks = async (queuePath, tasks, { generatedAt = new Date().toISOString() } = {}) => {
  if (!queuePath) throw new Error('자동 업무 큐 경로가 필요합니다.');
  if (!Array.isArray(tasks) || tasks.length === 0) return { additions: [], queue: null };
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  if (!Array.isArray(queue.tasks)) throw new Error('자동 업무 큐 형식이 올바르지 않습니다.');
  const additions = [];
  for (const task of tasks) {
    const sameFingerprint = queue.tasks.find((candidate) => candidate.triggerFingerprint === task.fingerprint || candidate.fingerprint === task.fingerprint);
    if (sameFingerprint && !['done', 'rejected', 'resolved', 'approved'].includes(sameFingerprint.status)) continue;
    const sameId = queue.tasks.some((candidate) => candidate.id === task.id);
    const queuedTask = {
      ...task,
      id: sameId ? `${task.id}-REOPEN-${String(generatedAt).replace(/[^0-9]/g, '').slice(0, 14)}` : task.id,
      triggerFingerprint: task.fingerprint,
      triggerTask: true,
      status: 'queued',
      enqueuedAt: generatedAt,
      updatedAt: generatedAt,
      ...(sameId ? { reopenedFrom: task.id } : {}),
    };
    queue.tasks.push(queuedTask);
    additions.push(queuedTask);
  }
  if (additions.length) await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  return { additions, queue };
};

/**
 * Closes stale automatic trigger work when the triggering signal is no longer
 * present in the current evidence packet. This is condition clearing, not a
 * human approval and never authorizes trades, contracts, payments, or release.
 */
export const reconcileTriggerQueue = async (queuePath, currentFingerprints = new Set(), { generatedAt = new Date().toISOString() } = {}) => {
  if (!queuePath) throw new Error('자동 업무 큐 경로가 필요합니다.');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  if (!Array.isArray(queue.tasks)) throw new Error('자동 업무 큐 형식이 올바르지 않습니다.');
  const active = currentFingerprints instanceof Set ? currentFingerprints : new Set(currentFingerprints);
  const resolvedTaskIds = [];
  const tasks = queue.tasks.map((task) => {
    if (!task?.triggerTask || !['queued', 'working', 'review'].includes(task.status) || active.has(task.triggerFingerprint || task.fingerprint)) return task;
    resolvedTaskIds.push(task.id);
    const resolvedAt = nextLifecycleTimestamp(task, generatedAt);
    return {
      ...task,
      status: 'resolved',
      resolvedAt,
      resolvedBy: 'SYSTEM',
      resolutionReason: 'TRIGGER_SIGNAL_CLEARED',
      lastRecheckResult: 'NOT_DETECTED',
      updatedAt: resolvedAt,
    };
  });
  if (resolvedTaskIds.length) await writeFile(queuePath, `${JSON.stringify({ ...queue, tasks }, null, 2)}\n`, 'utf8');
  return { queue: { ...queue, tasks }, resolvedTaskIds };
};

export { TRIGGER_DEFINITIONS };

