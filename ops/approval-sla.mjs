export const DEFAULT_APPROVAL_SLA_HOURS = { critical: 24, high: 48, medium: 72, low: 120 };

export const evaluateApprovalSla = ({ items = [], now = new Date(), slaHours = DEFAULT_APPROVAL_SLA_HOURS } = {}) => {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('승인 SLA 기준시각이 올바르지 않습니다.');
  const pending = (Array.isArray(items) ? items : []).filter((item) => item?.status === 'PENDING');
  const evaluated = pending.map((item) => {
    const createdMs = Date.parse(item.createdAt || '');
    const risk = item.risk || 'high';
    const thresholdHours = Number(slaHours[risk] ?? slaHours.high ?? 48);
    const ageHours = Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 3600000) : null;
    const stale = ageHours === null || ageHours >= thresholdHours;
    return {
      approvalId: item.approvalId || null,
      taskId: item.taskId || null,
      risk,
      createdAt: item.createdAt || null,
      ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
      thresholdHours,
      stale,
      action: stale ? 'ESCALATE_H01_REVIEW' : 'WAIT_WITHIN_SLA',
    };
  });
  return {
    evaluatedAt: new Date(nowMs).toISOString(),
    pendingCount: evaluated.length,
    staleCount: evaluated.filter((item) => item.stale).length,
    status: evaluated.some((item) => item.stale) ? 'STALE_APPROVALS' : 'WITHIN_SLA',
    humanPrincipal: 'H-01',
    externalNotificationSent: false,
    items: evaluated,
  };
};

