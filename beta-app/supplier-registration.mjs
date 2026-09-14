const BUSINESS_NUMBER_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];

export const normalizeBusinessRegistrationNumber = (value) => String(value ?? '').replace(/\D/g, '');

export const formatBusinessRegistrationNumber = (value) => {
  const digits = normalizeBusinessRegistrationNumber(value);
  if (digits.length !== 10) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
};

export const validateKoreanBusinessRegistrationNumber = (value) => {
  const raw = String(value ?? '').trim();
  if (raw && !/^[0-9-]+$/.test(raw)) return { valid: false, normalized: '', reason: '사업자등록번호에는 숫자와 하이픈만 입력할 수 있습니다.' };
  const normalized = normalizeBusinessRegistrationNumber(value);
  if (normalized.length !== 10) return { valid: false, normalized, reason: '사업자등록번호는 숫자 10자리여야 합니다.' };
  const digits = normalized.split('').map(Number);
  const weightedSum = BUSINESS_NUMBER_WEIGHTS.reduce((sum, weight, index) => sum + digits[index] * weight, 0);
  const checkDigit = (10 - ((weightedSum + Math.floor((digits[8] * 5) / 10)) % 10)) % 10;
  if (checkDigit !== digits[9]) return { valid: false, normalized, reason: '사업자등록번호 체크섬이 일치하지 않습니다.' };
  return { valid: true, normalized, formatted: formatBusinessRegistrationNumber(normalized) };
};

export const createSimulationSupplierRegistration = ({ organizationId, userId, businessRegistrationNumber, email, legalName = '', now = new Date().toISOString(), registrationId }) => {
  const validation = validateKoreanBusinessRegistrationNumber(businessRegistrationNumber);
  if (!validation.valid) {
    const error = new Error(validation.reason);
    error.code = 'BUSINESS_REGISTRATION_INVALID';
    throw error;
  }
  return {
    registrationId: registrationId || `SIM-SUPPLIER-REG-${validation.normalized}`,
    organizationId: String(organizationId),
    registeredBy: String(userId),
    businessRegistrationNumber: validation.normalized,
    formattedBusinessRegistrationNumber: validation.formatted,
    maskedBusinessRegistrationNumber: `${validation.normalized.slice(0, 3)}-${validation.normalized.slice(3, 5)}-****${validation.normalized.slice(-1)}`,
    email: String(email || '').trim(),
    legalName: String(legalName || '').trim().slice(0, 120),
    status: 'REGISTERED',
    registrationMode: 'SIMULATION_CHECKSUM_ONLY',
    registeredAt: now,
  };
};
