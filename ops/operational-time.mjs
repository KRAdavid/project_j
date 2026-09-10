/** Parse ISO and the Korean PowerShell date format without guessing unknown values. */
export const parseOperationalTimestamp = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const korean = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(오전|오후)\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!korean) return null;
  let hour = Number(korean[3]);
  if (korean[2] === '오전' && hour === 12) hour = 0;
  if (korean[2] === '오후' && hour < 12) hour += 12;
  const minute = Number(korean[4]);
  const second = Number(korean[5] || 0);
  const millisecond = Number(String(korean[6] || '').padEnd(3, '0') || 0);
  if (![hour, minute, second, millisecond].every(Number.isFinite) || hour > 23 || minute > 59 || second > 59 || millisecond > 999) return null;
  const parsed = Date.parse(`${korean[1]}T${String(hour).padStart(2, '0')}:${korean[4]}:${String(second).padStart(2, '0')}.${String(millisecond).padStart(3, '0')}+09:00`);
  return Number.isFinite(parsed) ? parsed : null;
};

export const toOperationalIso = (value) => {
  const parsed = value instanceof Date ? value.getTime() : parseOperationalTimestamp(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

