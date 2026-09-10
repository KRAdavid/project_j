import { randomUUID } from 'node:crypto';
import { EvidenceLockedInventory, InventoryRuleError, INVENTORY_STATES } from './inventory-ledger.mjs';
import { verifyEvidenceBundle } from './evidence-verifier.mjs';
import { sealTradeSnapshot, verifyTradeSnapshot } from './snapshot-integrity.mjs';
import { resolveMaterial } from './material-master.mjs';
import { GABA_TRADE_TERMS, resolveTradeTerms } from './trade-terms.mjs';

export const GABA_SPEC_ID = 'GABA-SPEC-001';
const GABA_MASTER = resolveMaterial('GABA');
export const GABA_SPEC_ATTRIBUTES = Object.fromEntries(GABA_MASTER.requiredSpecFields.map((field) => [field, GABA_MASTER.simulationSpec[field]]));

const clone = (value) => JSON.parse(JSON.stringify(value));

class TradeRuleError extends Error {
  constructor(message, code = 'TRADE_RULE_FAILED') {
    super(message);
    this.code = code;
  }
}

export class TradeEngine {
  constructor(initialSnapshot = null) {
    this.orderSequence = 0;
    this.tradeSequence = 0;
    this.orders = new Map();
    this.trades = new Map();
    this.idempotency = new Map();
    this.events = [];
    this.inventory = new EvidenceLockedInventory();
    this.inventory.registerLot({
      lotId: 'GBA-KR-2407',
      supplier: '한빛바이오',
      supplierId: 'SIM-SUPPLIER-001',
      supplierOrganizationId: 'SIM-SUPPLIER-ORG',
      specId: GABA_SPEC_ID,
      askPrice: 21800,
      ...GABA_TRADE_TERMS,
      availableQty: 1200,
      reservedQty: 0,
      status: INVENTORY_STATES.VERIFIED_ELIGIBLE,
      evidence: { coa: 'VALID', sds: 'VALID', tds: 'VALID', lotTrace: 'VALID', inventoryProof: 'VALID', expiresAt: '2027-07-31' },
      deliveryDays: 10,
    });
    this.lots = this.inventory.lots;
    if (initialSnapshot) this.restore(initialSnapshot);
    else this.recordEvent('SYSTEM_READY', 'GABA 검증 거래 원장이 준비되었습니다.');
  }

  restore(snapshot = {}) {
    const inventorySnapshot = snapshot.inventory || {};
    const lots = inventorySnapshot.lots || snapshot.lots || [];
    this.inventory.lots = new Map(lots.map((lot) => [String(lot.lotId), {
      ...clone(lot),
      currency: lot.currency || GABA_TRADE_TERMS.currency,
      priceUnit: lot.priceUnit || GABA_TRADE_TERMS.priceUnit,
      quantityUnit: lot.quantityUnit || GABA_TRADE_TERMS.quantityUnit,
    }]));
    this.lots = this.inventory.lots;
    this.inventory.reservations = new Map((inventorySnapshot.reservations || []).map((item) => [String(item.reservationId), clone(item)]));
    this.inventory.inspections = new Map((inventorySnapshot.inspections || []).map((item) => [String(item.reservationId), clone(item)]));
    this.orders = new Map((snapshot.orders || []).map((item) => [String(item.orderId), clone(item)]));
    this.trades = new Map((snapshot.trades || []).map((item) => [String(item.tradeId), clone(item)]));
    this.events = clone(snapshot.events || []);
    this.orderSequence = Math.max(0, ...[...this.orders.keys()].map((id) => Number(String(id).match(/(\d+)$/)?.[1] || 0)));
    this.tradeSequence = Math.max(0, ...[...this.trades.keys()].map((id) => Number(String(id).match(/(\d+)$/)?.[1] || 0)));
    this.idempotency = new Map();
    return this.snapshot();
  }

  recordEvent(type, message, details = {}) {
    this.events.unshift({
      eventId: `EVENT-${randomUUID().slice(0, 8).toUpperCase()}`,
      type,
      message,
      details,
      occurredAt: new Date().toISOString(),
    });
    this.events = this.events.slice(0, 50);
  }

  snapshot() {
    return {
      dataStatus: 'SIMULATED_BACKEND',
      material: { materialId: 'GABA', name: 'Gamma-Aminobutyric Acid' },
      specs: [clone(GABA_MASTER.simulationSpec)],
      lots: [...this.lots.values()].map(clone),
      inventory: this.inventory.snapshot(),
      orders: [...this.orders.values()].map(clone),
      trades: [...this.trades.values()].map(clone),
      events: clone(this.events),
    };
  }

  registerVerifiedLot(input = {}) {
    const lotId = String(input.lotId || '');
    const evidence = Array.isArray(input.evidence) ? input.evidence : [];
    const evidenceCheck = verifyEvidenceBundle({ lotId, evidence });
    if (!evidenceCheck.preTradeEligible) throw new TradeRuleError('거래 전 필수 증빙이 모두 유효하지 않아 매물을 등록할 수 없습니다.', 'PRETRADE_EVIDENCE_REQUIRED');
    const expiryDates = evidence.map((record) => new Date(record.expiresAt)).filter((date) => !Number.isNaN(date.valueOf()));
    const expiresAt = new Date(Math.min(...expiryDates.map((date) => date.valueOf()))).toISOString().slice(0, 10);
    let lot;
    try {
      lot = this.inventory.registerLot({
        lotId,
        supplier: String(input.supplier || ''),
        supplierId: String(input.supplierId || ''),
        supplierOrganizationId: String(input.supplierOrganizationId || ''),
        specId: String(input.specId || ''),
        askPrice: input.askPrice,
        ...resolveTradeTerms(input),
        availableQty: input.availableQty,
        reservedQty: 0,
        status: INVENTORY_STATES.VERIFIED_ELIGIBLE,
        evidence: {
          coa: 'VALID', sds: 'VALID', tds: 'VALID', lotTrace: 'VALID', inventoryProof: 'VALID', expiresAt,
        },
        deliveryDays: input.deliveryDays,
      });
    } catch (error) {
      if (error instanceof InventoryRuleError) throw new TradeRuleError(error.message, error.code);
      throw error;
    }
    this.recordEvent('LOT_VERIFIED', `${lot.supplier}의 ${lot.lotId} 매물이 거래 전 증빙 검증을 통과했습니다.`, { lotId: lot.lotId, evidencePolicy: evidenceCheck.policyId });
    return { lot: clone(lot), evidenceCheck, snapshot: this.snapshot() };
  }

  validateCommonInput(input) {
    const specId = input?.specId;
    const price = Number(input?.price);
    const quantity = Number(input?.quantity);
    if (specId !== GABA_SPEC_ID) throw new TradeRuleError('거래 스펙을 확인할 수 없습니다.', 'SPEC_NOT_CONFIRMED');
    let tradeTerms;
    try { tradeTerms = resolveTradeTerms(input); } catch (error) { throw new TradeRuleError(error.message, error.code); }
    if (!Number.isFinite(price) || price < 1) throw new TradeRuleError('매수가가 올바르지 않습니다.', 'INVALID_PRICE');
    if (!Number.isInteger(quantity) || quantity < 20 || quantity > 1200) {
      throw new TradeRuleError('주문 수량은 20kg 이상 1,200kg 이하이어야 합니다.', 'INVENTORY_LIMIT');
    }
    const providedAttributes = input?.specAttributes;
    if (!providedAttributes || typeof providedAttributes !== 'object' || Array.isArray(providedAttributes)) {
      throw new TradeRuleError('거래 전 확정된 스펙 답변이 필요합니다.', 'SPEC_ATTRIBUTES_REQUIRED');
    }
    const allowedFields = new Set(GABA_MASTER.requiredSpecFields);
    const unknownField = Object.keys(providedAttributes).find((field) => !allowedFields.has(field));
    if (unknownField) throw new TradeRuleError(`등록되지 않은 스펙 항목입니다: ${unknownField}`, 'SPEC_FIELD_UNKNOWN');
    const specAttributes = {};
    for (const field of GABA_MASTER.requiredSpecFields) {
      const value = providedAttributes[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        throw new TradeRuleError(`필수 스펙 항목이 비어 있습니다: ${field}`, 'SPEC_ATTRIBUTES_REQUIRED');
      }
      const question = GABA_MASTER.specQuestionFlow.find((candidate) => candidate.field === field);
      const normalized = String(value).trim();
      if (!question?.options?.includes(normalized)) throw new TradeRuleError(`${question?.label || field} 선택값이 허용 목록에 없습니다.`, 'SPEC_OPTION_INVALID');
      specAttributes[field] = normalized;
    }
    const missingField = GABA_MASTER.requiredSpecFields.find((field) => !String(specAttributes[field] || '').trim());
    if (missingField) throw new TradeRuleError(`필수 스펙 항목이 비어 있습니다: ${missingField}`, 'SPEC_ATTRIBUTES_REQUIRED');
    const mismatchedField = GABA_MASTER.requiredSpecFields.find((field) => String(specAttributes[field]) !== String(GABA_MASTER.simulationSpec[field]));
    if (mismatchedField) throw new TradeRuleError(`현재 검증 로트와 일치하지 않는 스펙입니다: ${mismatchedField}`, 'SPEC_NOT_MATCHED');
    return { specId, price, quantity, specAttributes, tradeTerms };
  }

  verifyLot(lot, order) {
    const checks = this.inventory.verifyLot(lot, order);
    const failed = Object.entries(checks).find(([, passed]) => !passed);
    if (failed) throw new TradeRuleError(`거래 전 검증 실패: ${failed[0]}`, failed[0].toUpperCase());
    return checks;
  }

  submitOrder(input = {}) {
    const idempotencyKey = String(input.idempotencyKey || '');
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) return clone(this.idempotency.get(idempotencyKey));
    const { specId, price, quantity, specAttributes, tradeTerms } = this.validateCommonInput(input);
    const deliveryDays = Number.isInteger(Number(input.deliveryDays)) ? Number(input.deliveryDays) : 14;
    const candidateLot = this.inventory.findEligible({ specId, price, quantity, deliveryDays });
    if (!candidateLot) throw new TradeRuleError('현재 조건에 맞는 검증 매물이 없습니다.', 'NO_ELIGIBLE_OFFER');
    const order = {
      orderId: `ORDER-${String(++this.orderSequence).padStart(5, '0')}`,
      buyerId: String(input.buyerId || 'SIM-BUYER-001'),
      buyerOrganizationId: String(input.buyerOrganizationId || 'SIM-BUYER-ORG'),
      specId,
      ...tradeTerms,
      specAttributes,
      price,
      quantity,
      deliveryDate: String(input.deliveryDate || ''),
      deliveryDays,
      candidateLotId: candidateLot.lotId,
      expiresAt: input.expiresAt ? String(input.expiresAt) : null,
      status: 'BUY_ORDER_SUBMITTED',
      preTradeGate: {
        specMatch: true,
        evidenceValid: true,
        lotTraceable: true,
        inventoryAvailable: true,
      },
      createdAt: new Date().toISOString(),
    };
    this.orders.set(order.orderId, order);
    this.recordEvent('ORDER_SUBMITTED', `${candidateLot.supplier}에 GABA 구매 주문이 전달되었습니다.`, { orderId: order.orderId, lotId: candidateLot.lotId });
    const response = { order: clone(order), snapshot: this.snapshot() };
    if (idempotencyKey) this.idempotency.set(idempotencyKey, response);
    return clone(response);
  }

  markDelivered(tradeId) {
    const trade = this.trades.get(String(tradeId));
    if (!trade) throw new TradeRuleError('체결을 찾을 수 없습니다.', 'TRADE_NOT_FOUND');
    if (!verifyTradeSnapshot(trade)) throw new TradeRuleError('체결 스냅샷 무결성 검증에 실패했습니다.', 'TRADE_SNAPSHOT_TAMPERED');
    if (trade.status !== 'TRADE_CONFIRMED') throw new TradeRuleError('납품 처리할 수 없는 체결 상태입니다.', 'INVALID_DELIVERY_STATE');
    try { this.inventory.markDelivered(trade.reservationId); } catch (error) {
      if (error instanceof InventoryRuleError) throw new TradeRuleError(error.message, error.code);
      throw error;
    }
    trade.status = 'DELIVERED';
    trade.deliveredAt = new Date().toISOString();
    this.recordEvent('TRADE_DELIVERED', `${trade.tradeId}가 납품 처리되었습니다.`, { tradeId: trade.tradeId, reservationId: trade.reservationId });
    return { trade: clone(trade), snapshot: this.snapshot() };
  }

  inspectTrade(tradeId, input = {}) {
    const trade = this.trades.get(String(tradeId));
    if (!trade) throw new TradeRuleError('체결을 찾을 수 없습니다.', 'TRADE_NOT_FOUND');
    if (!verifyTradeSnapshot(trade)) throw new TradeRuleError('체결 스냅샷 무결성 검증에 실패했습니다.', 'TRADE_SNAPSHOT_TAMPERED');
    if (!['TRADE_CONFIRMED', 'DELIVERED'].includes(trade.status)) throw new TradeRuleError('검수할 수 없는 체결 상태입니다.', 'INVALID_INSPECTION_STATE');
    let inspection;
    try { inspection = this.inventory.inspect(trade.reservationId, input); } catch (error) {
      if (error instanceof InventoryRuleError) throw new TradeRuleError(error.message, error.code);
      throw error;
    }
    trade.status = inspection.inspection.status === 'INSPECTED' ? 'FULFILLED' : 'DISPUTED';
    trade.inspectionSnapshot = clone(inspection.inspection);
    trade.fulfilledAt = trade.status === 'FULFILLED' ? inspection.inspection.inspectedAt : null;
    this.recordEvent(trade.status === 'FULFILLED' ? 'TRADE_FULFILLED' : 'TRADE_DISPUTED', `${trade.tradeId} 검수 결과가 ${trade.status}로 기록되었습니다.`, { tradeId: trade.tradeId, reservationId: trade.reservationId });
    return { trade: clone(trade), inspection: clone(inspection.inspection), snapshot: this.snapshot() };
  }

  acceptOrder(orderId, input = {}) {
    const idempotencyKey = String(input.idempotencyKey || '');
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) return clone(this.idempotency.get(idempotencyKey));
    const order = this.orders.get(orderId);
    if (!order) throw new TradeRuleError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
    if (order.status !== 'BUY_ORDER_SUBMITTED') throw new TradeRuleError('이미 처리된 주문입니다.', 'ORDER_ALREADY_PROCESSED');
    const validatedOrder = this.validateCommonInput({ specId: order.specId, price: order.price, quantity: order.quantity, deliveryDays: order.deliveryDays, specAttributes: order.specAttributes, ...order });
    order.specAttributes = validatedOrder.specAttributes;
    if (order.expiresAt && new Date(order.expiresAt) <= new Date()) throw new TradeRuleError('주문 유효기간이 만료되었습니다.', 'ORDER_EXPIRED');
    const lot = this.lots.get(String(input.lotId || order.candidateLotId));
    if (!lot) throw new TradeRuleError('공급 로트를 찾을 수 없습니다.', 'LOT_NOT_FOUND');
    if (input.supplierId && lot.supplierId && String(input.supplierId) !== lot.supplierId) throw new TradeRuleError('해당 공급자의 로트가 아닙니다.', 'SUPPLIER_NOT_AUTHORIZED');
    if (input.supplierOrganizationId && lot.supplierOrganizationId && String(input.supplierOrganizationId) !== lot.supplierOrganizationId) throw new TradeRuleError('해당 공급자 조직의 로트가 아닙니다.', 'SUPPLIER_ORGANIZATION_NOT_AUTHORIZED');
    try { resolveTradeTerms(lot, validatedOrder.tradeTerms); } catch (error) { throw new TradeRuleError(error.message, error.code); }
    const acceptedQuantity = input.acceptedQuantity === undefined ? order.quantity : Number(input.acceptedQuantity);
    if (!Number.isInteger(acceptedQuantity) || acceptedQuantity < 20 || acceptedQuantity > order.quantity) {
      throw new TradeRuleError('부분 체결 수량은 20kg 이상 원주문 수량 이하이어야 합니다.', 'INVALID_ACCEPTED_QUANTITY');
    }
    let reservation;
    try {
      const reservationId = acceptedQuantity === order.quantity ? order.orderId : `${order.orderId}:PARTIAL:${acceptedQuantity}`;
      reservation = this.inventory.reserve(lot.lotId, acceptedQuantity, reservationId, { ...order, quantity: acceptedQuantity });
    } catch (error) {
      if (error instanceof InventoryRuleError) throw new TradeRuleError(error.message, error.code);
      throw error;
    }
    const checks = reservation.reservation.checks;
    const trade = {
      tradeId: `TRADE-${String(++this.tradeSequence).padStart(5, '0')}`,
      orderId: order.orderId,
      buyerId: order.buyerId,
      supplier: lot.supplier,
      supplierId: lot.supplierId,
      supplierOrganizationId: lot.supplierOrganizationId,
      materialId: 'GABA',
      specId: order.specId,
      ...validatedOrder.tradeTerms,
      specSnapshot: clone(order.specAttributes),
      lotSnapshot: { lotId: lot.lotId, supplier: lot.supplier, quantity: acceptedQuantity, remainingQty: reservation.lot.availableQty },
      evidenceSnapshot: clone(lot.evidence),
      price: order.price,
      quantity: acceptedQuantity,
      deliveryDate: order.deliveryDate,
      preTradeChecks: checks,
      reservationId: reservation.reservation.reservationId,
      status: 'TRADE_CONFIRMED',
      confirmedAt: new Date().toISOString(),
    };
    order.status = acceptedQuantity === order.quantity ? 'TRADE_CONFIRMED' : 'PARTIALLY_ACCEPTED';
    order.acceptedQuantity = acceptedQuantity;
    order.remainingQuantity = order.quantity - acceptedQuantity;
    order.tradeId = trade.tradeId;
    this.trades.set(trade.tradeId, trade);
    this.recordEvent('TRADE_CONFIRMED', `${lot.supplier}가 주문 ${acceptedQuantity.toLocaleString('ko-KR')}kg을 체결하고 재고를 잠갔습니다.`, { tradeId: trade.tradeId, lotId: lot.lotId, partial: acceptedQuantity < order.quantity });
    const sealedTrade = sealTradeSnapshot(trade);
    this.trades.set(trade.tradeId, sealedTrade);
    const response = { order: clone(order), trade: clone(sealedTrade), snapshot: this.snapshot() };
    if (idempotencyKey) this.idempotency.set(idempotencyKey, response);
    return clone(response);
  }

  counterOrder(orderId, input = {}) {
    const idempotencyKey = String(input.idempotencyKey || '');
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) return clone(this.idempotency.get(idempotencyKey));
    const order = this.orders.get(orderId);
    if (!order) throw new TradeRuleError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
    if (order.status !== 'BUY_ORDER_SUBMITTED') throw new TradeRuleError('역제안할 수 없는 주문입니다.', 'ORDER_ALREADY_PROCESSED');
    const orderLot = this.lots.get(String(order.candidateLotId));
    if (input.supplierId && orderLot?.supplierId && String(input.supplierId) !== orderLot.supplierId) throw new TradeRuleError('해당 공급자의 주문이 아닙니다.', 'SUPPLIER_NOT_AUTHORIZED');
    if (input.supplierOrganizationId && orderLot?.supplierOrganizationId && String(input.supplierOrganizationId) !== orderLot.supplierOrganizationId) throw new TradeRuleError('해당 공급자 조직의 주문이 아닙니다.', 'SUPPLIER_ORGANIZATION_NOT_AUTHORIZED');
    const { specId, price, quantity, specAttributes, tradeTerms } = this.validateCommonInput({ ...order, ...input, specId: input.specId || order.specId, specAttributes: input.specAttributes || order.specAttributes });
    const deliveryDays = Number.isInteger(Number(input.deliveryDays)) ? Number(input.deliveryDays) : order.deliveryDays;
    const candidateLot = [...this.lots.values()]
      .filter((lot) => Object.values(this.inventory.verifyLot(lot, { specId, quantity, deliveryDays })).every(Boolean))
      .sort((a, b) => a.askPrice - b.askPrice)[0];
    if (!candidateLot) throw new TradeRuleError('역제안 조건에 맞는 검증 로트가 없습니다.', 'NO_ELIGIBLE_COUNTER_OFFER');
    order.status = 'COUNTERED';
    order.counterOffer = { specId, specAttributes, price, quantity, deliveryDays, ...tradeTerms, lotId: candidateLot.lotId, supplier: candidateLot.supplier, createdAt: new Date().toISOString() };
    this.recordEvent('ORDER_COUNTERED', `${candidateLot.supplier}가 구매 주문에 역제안했습니다.`, { orderId: order.orderId, lotId: candidateLot.lotId });
    const response = { order: clone(order), snapshot: this.snapshot() };
    if (idempotencyKey) this.idempotency.set(idempotencyKey, response);
    return clone(response);
  }

  rejectOrder(orderId, input = {}) {
    const idempotencyKey = String(input.idempotencyKey || '');
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) return clone(this.idempotency.get(idempotencyKey));
    const order = this.orders.get(orderId);
    if (!order) throw new TradeRuleError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
    if (!['BUY_ORDER_SUBMITTED', 'COUNTERED'].includes(order.status)) throw new TradeRuleError('거절할 수 없는 주문입니다.', 'ORDER_ALREADY_PROCESSED');
    const candidateLot = this.lots.get(String(order.candidateLotId));
    if (input.supplierId && candidateLot?.supplierId && String(input.supplierId) !== candidateLot.supplierId) throw new TradeRuleError('해당 공급자의 주문이 아닙니다.', 'SUPPLIER_NOT_AUTHORIZED');
    order.status = 'REJECTED';
    order.rejectionReason = String(input.reason || '공급자 조건에 맞지 않습니다.');
    this.recordEvent('ORDER_REJECTED', '공급자가 구매 주문을 거절했습니다.', { orderId: order.orderId });
    const response = { order: clone(order), snapshot: this.snapshot() };
    if (idempotencyKey) this.idempotency.set(idempotencyKey, response);
    return clone(response);
  }

  expireOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new TradeRuleError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
    if (!order.expiresAt || new Date(order.expiresAt) > new Date()) throw new TradeRuleError('아직 만료되지 않은 주문입니다.', 'ORDER_NOT_EXPIRED');
    if (!['BUY_ORDER_SUBMITTED', 'COUNTERED'].includes(order.status)) throw new TradeRuleError('만료 처리할 수 없는 주문입니다.', 'ORDER_ALREADY_PROCESSED');
    order.status = 'EXPIRED';
    this.recordEvent('ORDER_EXPIRED', '주문 유효기간이 만료되었습니다.', { orderId: order.orderId });
    return { order: clone(order), snapshot: this.snapshot() };
  }
}

export { TradeRuleError };
