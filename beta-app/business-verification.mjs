import {
  formatBusinessRegistrationNumber,
  normalizeBusinessRegistrationNumber,
  validateKoreanBusinessRegistrationNumber,
} from './supplier-registration.mjs';

const DEFAULT_TIMEOUT_MS = 5000;

export class BusinessVerificationError extends Error {
  constructor(message, code = 'BUSINESS_VERIFICATION_FAILED') {
    super(message);
    this.code = code;
  }
}

const assertValidBusinessNumber = (value) => {
  const validation = validateKoreanBusinessRegistrationNumber(value);
  if (!validation.valid) throw new BusinessVerificationError(validation.reason, 'BUSINESS_REGISTRATION_INVALID');
  return validation;
};

/**
 * Beta-only check. A valid checksum is deliberately not represented as an
 * official verification, because it does not prove that the business exists
 * or is currently operating.
 */
export const createSimulationBusinessVerification = ({ businessRegistrationNumber, now = new Date().toISOString() } = {}) => {
  const validation = assertValidBusinessNumber(businessRegistrationNumber);
  return {
    status: 'FORMAT_VALID',
    verified: false,
    mode: 'SIMULATION_CHECKSUM_ONLY',
    businessRegistrationNumber: validation.normalized,
    formattedBusinessRegistrationNumber: formatBusinessRegistrationNumber(validation.normalized),
    checkedAt: now,
    guardrail: '체크섬 검사는 공식 기관의 사업자 상태 확인을 대체하지 않습니다.',
  };
};

export const createHttpBusinessRegistrationProvider = ({
  endpoint = process.env.BUSINESS_REGISTRATION_PROVIDER_URL,
  apiKey = process.env.BUSINESS_REGISTRATION_PROVIDER_API_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedEndpoint) throw new BusinessVerificationError('공식 사업자 확인 제공자 URL이 설정되지 않았습니다.', 'BUSINESS_REGISTRATION_PROVIDER_NOT_CONFIGURED');
  if (!String(apiKey || '').trim()) throw new BusinessVerificationError('공식 사업자 확인 제공자 인증키가 설정되지 않았습니다.', 'BUSINESS_REGISTRATION_PROVIDER_NOT_CONFIGURED');
  if (typeof fetchImpl !== 'function') throw new BusinessVerificationError('사업자 확인 제공자 HTTP 클라이언트가 없습니다.', 'BUSINESS_REGISTRATION_HTTP_CLIENT_REQUIRED');
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 1000 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

  return {
    async verify({ businessRegistrationNumber } = {}) {
      const validation = assertValidBusinessNumber(businessRegistrationNumber);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
      let response;
      try {
        response = await fetchImpl(normalizedEndpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-api-key': String(apiKey).trim(),
          },
          body: JSON.stringify({ businessRegistrationNumber: validation.normalized }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new BusinessVerificationError('공식 사업자 확인 제공자에 연결하지 못했습니다.', error?.name === 'AbortError' ? 'BUSINESS_REGISTRATION_PROVIDER_TIMEOUT' : 'BUSINESS_REGISTRATION_PROVIDER_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
      }
      if (!response?.ok) throw new BusinessVerificationError('공식 사업자 확인 제공자가 검증에 실패했습니다.', 'BUSINESS_REGISTRATION_PROVIDER_HTTP_FAILED');
      let payload;
      try { payload = await response.json(); } catch { throw new BusinessVerificationError('공식 사업자 확인 응답이 JSON 형식이 아닙니다.', 'BUSINESS_REGISTRATION_PROVIDER_RESPONSE_INVALID'); }
      const returnedNumber = normalizeBusinessRegistrationNumber(payload?.businessRegistrationNumber ?? payload?.businessNumber ?? validation.normalized);
      if (returnedNumber !== validation.normalized) throw new BusinessVerificationError('공식 사업자 확인 응답의 사업자번호가 요청과 다릅니다.', 'BUSINESS_REGISTRATION_PROVIDER_MISMATCH');
      return {
        verified: payload?.verified === true,
        providerStatus: String(payload?.status || '').trim().toUpperCase() || 'UNKNOWN',
        providerReference: String(payload?.providerReference || '').trim() || null,
      };
    },
  };
};

export const verifyOfficialBusinessRegistration = async ({ businessRegistrationNumber, provider, now = new Date().toISOString() } = {}) => {
  const validation = assertValidBusinessNumber(businessRegistrationNumber);
  if (!provider || typeof provider.verify !== 'function') throw new BusinessVerificationError('공식 사업자 확인 제공자가 연결되지 않았습니다.', 'BUSINESS_REGISTRATION_PROVIDER_REQUIRED');
  let result;
  try { result = await provider.verify({ businessRegistrationNumber: validation.normalized }); }
  catch (error) {
    if (error instanceof BusinessVerificationError) throw error;
    throw new BusinessVerificationError('공식 사업자 확인 결과를 받지 못했습니다.', 'BUSINESS_REGISTRATION_PROVIDER_FAILED');
  }
  if (result?.verified !== true) throw new BusinessVerificationError('공식 사업자 확인이 완료되지 않아 자동 등록할 수 없습니다.', 'BUSINESS_REGISTRATION_NOT_VERIFIED');
  return {
    status: 'OFFICIALLY_VERIFIED',
    verified: true,
    mode: 'OFFICIAL_PROVIDER',
    businessRegistrationNumber: validation.normalized,
    formattedBusinessRegistrationNumber: formatBusinessRegistrationNumber(validation.normalized),
    providerStatus: String(result.providerStatus || 'VERIFIED').trim().toUpperCase(),
    providerReference: result.providerReference || null,
    checkedAt: now,
  };
};

