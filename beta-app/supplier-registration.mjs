const BUSINESS_NUMBER_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5];
const SUPPORTED_COA_EXTENSIONS = /\.(pdf|png|jpe?g)$/i;
const MAX_COA_METADATA_SIZE = 10 * 1024 * 1024;

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
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
    const error = new Error('공급자 등록에는 유효한 업무용 이메일이 필요합니다.');
    error.code = 'BUSINESS_EMAIL_INVALID';
    throw error;
  }
  return {
    registrationId: registrationId || `SIM-SUPPLIER-REG-${validation.normalized}`,
    organizationId: String(organizationId),
    registeredBy: String(userId),
    businessRegistrationNumber: validation.normalized,
    formattedBusinessRegistrationNumber: validation.formatted,
    maskedBusinessRegistrationNumber: `${validation.normalized.slice(0, 3)}-${validation.normalized.slice(3, 5)}-****${validation.normalized.slice(-1)}`,
    email: normalizedEmail,
    legalName: String(legalName || '').trim().slice(0, 120),
    status: 'REGISTERED',
    registrationMode: 'SIMULATION_CHECKSUM_ONLY',
    businessVerification: {
      status: 'FORMAT_VALID',
      verified: false,
      mode: 'SIMULATION_CHECKSUM_ONLY',
      checkedAt: now,
      guardrail: '체크섬 검사는 공식 기관의 사업자 상태 확인을 대체하지 않습니다.',
    },
    registeredAt: now,
  };
};

export const evaluateSupplierAiPrecheck = ({ material = '', coaDocumentNumber = '', coaFileName = '', coaFileSize = 0, coaFileSha256 = '', coaStorageRef = '', coaFileSignatureVerified = false, inventoryQuantity = 0, unit = '', expiry = '', priceTiers = [], reviewScope = 'SUPPLY_OFFER', now = new Date().toISOString() } = {}) => {
  const normalizedReviewScope = String(reviewScope || 'SUPPLY_OFFER').trim().toUpperCase();
  const supportedReviewScope = ['EVIDENCE_ONLY', 'SUPPLY_OFFER', 'ORDER_RESPONSE'].includes(normalizedReviewScope);
  const pricingRequired = normalizedReviewScope !== 'EVIDENCE_ONLY';
  const normalizedFileName = String(coaFileName || '').trim();
  const normalizedSize = Number(coaFileSize || 0);
  const normalizedFileSha256 = String(coaFileSha256 || '').trim().toLowerCase();
  const normalizedInventory = Number(inventoryQuantity || 0);
  const normalizedUnit = String(unit || '').trim().toUpperCase();
  const expiryDate = String(expiry || '').trim();
  const supportedFile = SUPPORTED_COA_EXTENSIONS.test(normalizedFileName) && normalizedSize > 0 && normalizedSize <= MAX_COA_METADATA_SIZE;
  const validExpiry = /^\d{4}-\d{2}-\d{2}$/.test(expiryDate) && expiryDate >= String(now).slice(0, 10);
  const validUnit = ['KG', 'L', 'EA'].includes(normalizedUnit);
  const validPriceTiers = !pricingRequired || (Array.isArray(priceTiers) && priceTiers.some((tier) => Number(tier?.quantity || 0) > 0 && Number(tier?.price || 0) > 0));
  const checks = {
    reviewScopeValid: supportedReviewScope,
    materialPresent: Boolean(String(material || '').trim()),
    coaReferencePresent: Boolean(String(coaDocumentNumber || '').trim()),
    coaFilePresent: Boolean(normalizedFileName),
    supportedFile,
    coaFileFingerprintPresent: /^[a-f0-9]{64}$/.test(normalizedFileSha256),
    coaStorageRefPresent: Boolean(String(coaStorageRef || '').trim()),
    coaFileSignatureVerified: coaFileSignatureVerified === true,
    inventoryQuantityPositive: normalizedInventory > 0,
    validUnit,
    expiryNotPast: validExpiry,
    priceTierPresent: validPriceTiers,
  };
  const reasons = Object.entries(checks).filter(([, passed]) => !passed).map(([check]) => ({
    reviewScopeValid: '사전검토 범위가 올바르지 않습니다.',
    materialPresent: '공급 원료명이 필요합니다.',
    coaReferencePresent: 'COA 문서번호가 필요합니다.',
    coaFilePresent: 'COA 파일이 필요합니다.',
    supportedFile: 'COA는 10MB 이하의 PDF·JPG·PNG 파일이어야 합니다.',
    coaFileFingerprintPresent: 'COA 파일 SHA-256 지문을 계산할 수 있어야 합니다.',
    coaStorageRefPresent: '원문 파일 저장 참조가 필요합니다.',
    coaFileSignatureVerified: 'COA 원문 형식과 확장자 일치 확인이 필요합니다.',
    inventoryQuantityPositive: '검증 재고수량은 0보다 커야 합니다.',
    validUnit: '거래 단위가 올바르지 않습니다.',
    expiryNotPast: '소비기한은 오늘 이후 날짜여야 합니다.',
    priceTierPresent: '수량별 공급 단가가 최소 한 구간 필요합니다.',
  }[check]));
  return {
    reviewScope: normalizedReviewScope,
    status: reasons.length === 0 ? 'REVIEWED' : 'NEEDS_REVIEW',
    mode: 'SIMULATION_AI_PRECHECK',
    ready: reasons.length === 0,
    checks,
    reasons,
    reviewedAt: now,
    guardrail: 'AI는 파일 지문과 입력값을 사전검토할 뿐 공급자 승인·매물 공개·거래 체결을 수행하지 않습니다.',
  };
};

