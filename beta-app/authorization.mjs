import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const policyPath = resolve(fileURLToPath(new URL('../data/authorization-policy.json', import.meta.url)));

export class AuthorizationError extends Error {
  constructor(message, code = 'AUTHORIZATION_FAILED') {
    super(message);
    this.code = code;
  }
}

export const loadAuthorizationPolicy = async () => JSON.parse(await readFile(policyPath, 'utf8'));

const normalizeRole = (role) => String(role || '').trim().toUpperCase();

const decodeBase64UrlJson = (value) => {
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); } catch { return null; }
};

const verifyProductionBearer = (request) => {
  const secret = String(process.env.AUTH_JWT_SECRET || '');
  const issuer = String(process.env.AUTH_JWT_ISSUER || '').trim();
  const audience = String(process.env.AUTH_JWT_AUDIENCE || '').trim();
  if (secret.length < 32) throw new AuthorizationError('상용 인증 검증 비밀키가 설정되지 않았습니다.', 'AUTH_PROVIDER_NOT_CONFIGURED');
  if (!issuer || !audience) throw new AuthorizationError('상용 인증 issuer·audience가 설정되지 않았습니다.', 'AUTH_PROVIDER_NOT_CONFIGURED');
  const authorization = String(request.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw new AuthorizationError('상용 모드에서는 서명된 Bearer 토큰이 필요합니다.', 'AUTHENTICATION_REQUIRED');
  const token = match[1];
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthorizationError('인증 토큰 형식이 올바르지 않습니다.', 'AUTHENTICATION_INVALID');
  const header = decodeBase64UrlJson(parts[0]);
  const payload = decodeBase64UrlJson(parts[1]);
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT' || !payload) throw new AuthorizationError('지원되지 않거나 손상된 인증 토큰입니다.', 'AUTHENTICATION_INVALID');
  const actualSignature = Buffer.from(parts[2], 'base64url');
  const expectedSignature = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) throw new AuthorizationError('인증 토큰 서명이 유효하지 않습니다.', 'AUTHENTICATION_INVALID');
  if (!payload.sub || !payload.org || !payload.role || !Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= Math.floor(Date.now() / 1000)) throw new AuthorizationError('인증 토큰이 만료되었거나 필수 클레임이 없습니다.', 'AUTHENTICATION_INVALID');
  if (payload.iss !== issuer) throw new AuthorizationError('인증 토큰 발급자가 일치하지 않습니다.', 'AUTHENTICATION_INVALID');
  if (payload.aud !== audience) throw new AuthorizationError('인증 토큰 대상이 일치하지 않습니다.', 'AUTHENTICATION_INVALID');
  const role = normalizeRole(payload.role);
  if (!role || role === 'AI' || !['OWNER', 'ADMIN', 'BUYER', 'SUPPLIER', 'OPERATOR', 'AUDITOR'].includes(role)) throw new AuthorizationError('인증 토큰 역할이 허용되지 않습니다.', 'AUTHENTICATION_INVALID');
  return { role, userId: String(payload.sub), organizationId: String(payload.org), environment: 'production' };
};

export const resolvePrincipal = (request, { environment = process.env.APP_ENV || 'simulation', fallbackRole = 'BUYER' } = {}) => {
  const isProduction = environment === 'production';
  if (isProduction) return verifyProductionBearer(request);
  const rawRole = request.headers['x-raw-role'];
  const demoRole = request.headers['x-demo-role'];
  const role = normalizeRole(rawRole || demoRole || fallbackRole);
  const userId = String(request.headers['x-raw-user-id'] || (role === 'SUPPLIER' ? 'SIM-SUPPLIER-001' : 'SIM-BUYER-001'));
  const organizationId = String(request.headers['x-raw-organization-id'] || (role === 'SUPPLIER' ? 'SIM-SUPPLIER-ORG' : 'SIM-BUYER-ORG'));
  if (!role || !userId || !organizationId) throw new AuthorizationError('사용자·조직·역할 정보가 완전하지 않습니다.', 'AUTHENTICATION_REQUIRED');
  return { role, userId, organizationId, environment };
};

export const authorize = (principal, action, policy) => {
  const allowed = policy.roles?.[principal.role] || [];
  if (!allowed.includes(action)) throw new AuthorizationError(`${principal.role} 역할은 ${action} 권한이 없습니다.`, 'FORBIDDEN_ACTION');
  if (principal.role === 'AI' && policy.aiDeniedActions?.includes(action)) {
    throw new AuthorizationError('AI 역할은 인간 승인 필요 작업을 수행할 수 없습니다.', 'AI_ACTION_DENIED');
  }
  return true;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

export const projectEvidence = (records, principal) => {
  const list = Array.isArray(records) ? records : [];
  if (['OWNER', 'ADMIN', 'OPERATOR', 'AUDITOR'].includes(principal.role)) return clone(list);
  if (principal.role === 'SUPPLIER') return clone(list.filter((record) => record.organizationId === principal.organizationId));
  return clone(list.map(({ contentSha256, storageRef, organizationId, submittedBy, reviewedBy, reviewedAt, ...publicRecord }) => publicRecord));
};

export const projectSnapshot = (snapshot, principal) => {
  if (['OWNER', 'ADMIN', 'OPERATOR', 'AUDITOR'].includes(principal.role)) return clone(snapshot);
  const ownOrder = (order) => order.buyerId === principal.userId || order.buyerOrganizationId === principal.organizationId;
  const ownLot = (lot) => lot.supplierId === principal.userId || lot.supplierOrganizationId === principal.organizationId;
  const orders = principal.role === 'SUPPLIER'
    ? snapshot.orders.filter((order) => !order.candidateLotId || snapshot.lots.some((lot) => lot.lotId === order.candidateLotId && ownLot(lot)))
    : snapshot.orders.filter(ownOrder);
  const visibleOrders = principal.role === 'SUPPLIER'
    ? orders.map(({ buyerId, buyerOrganizationId, ...publicOrder }) => publicOrder)
    : orders;
  const orderIds = new Set(orders.map((order) => order.orderId));
  const trades = principal.role === 'SUPPLIER'
    ? snapshot.trades.filter((trade) => trade.supplierId === principal.userId || snapshot.lots.some((lot) => lot.lotId === trade.lotSnapshot?.lotId && ownLot(lot)))
    : snapshot.trades.filter((trade) => orderIds.has(trade.orderId));
  const visibleLot = (lot) => {
    const { supplierId, supplierOrganizationId, evidence, ...publicLot } = lot;
    return { ...publicLot, evidenceStatus: evidence ? 'PRETRADE_VERIFIED' : 'UNAVAILABLE' };
  };
  const isPubliclyEligible = (lot) => {
    const expiry = lot.evidence?.expiresAt ? new Date(lot.evidence.expiresAt) : null;
    const expiryValid = !expiry || (Number.isFinite(expiry.valueOf()) && expiry >= new Date());
    const quantityValid = lot.availableQty === undefined || Number(lot.availableQty) > 0;
    const stateValid = !lot.status || lot.status === 'VERIFIED_ELIGIBLE';
    return stateValid && expiryValid && quantityValid;
  };
  const lots = principal.role === 'SUPPLIER' ? snapshot.lots.filter(ownLot).map(visibleLot) : snapshot.lots.filter(isPubliclyEligible).map(visibleLot);
  const visibleTrades = trades.map((trade) => {
    const { buyerId, buyerOrganizationId, supplierId, supplierOrganizationId, ...publicTrade } = trade;
    return publicTrade;
  });
  const safeSnapshot = clone(snapshot);
  delete safeSnapshot.evidence;
  if (safeSnapshot.inventory) {
    safeSnapshot.inventory = {
      ...safeSnapshot.inventory,
      lots: lots,
      reservations: (safeSnapshot.inventory.reservations || []).filter((reservation) => principal.role === 'SUPPLIER'
        ? lots.some((lot) => lot.lotId === reservation.lotId)
        : orderIds.has(reservation.orderId)),
      inspections: (safeSnapshot.inventory.inspections || []).filter((inspection) => visibleTrades.some((trade) => trade.tradeId === inspection.tradeId)),
    };
  }
  const visibleEventIds = new Set([...orders.map((order) => order.orderId), ...trades.map((trade) => trade.tradeId)]);
  return {
    ...safeSnapshot,
    lots,
    orders: clone(visibleOrders),
    trades: clone(visibleTrades),
    events: clone(snapshot.events.filter((event) => !event.details?.orderId && !event.details?.tradeId || [...visibleEventIds].some((id) => event.details?.orderId === id || event.details?.tradeId === id))),
  };
};
