const clone = (value) => JSON.parse(JSON.stringify(value));
const CANONICAL_TRADE_TERMS = Object.freeze({ currency: 'KRW', priceUnit: 'KRW_PER_KG', quantityUnit: 'KG' });

export const INVENTORY_STATES = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  VERIFIED_ELIGIBLE: 'VERIFIED_ELIGIBLE',
  RESERVED: 'RESERVED',
  DELIVERED: 'DELIVERED',
  INSPECTED: 'INSPECTED',
  DISPUTED: 'DISPUTED',
  QUARANTINED: 'QUARANTINED',
  EXPIRED: 'EXPIRED',
});

export class InventoryRuleError extends Error {
  constructor(message, code = 'INVENTORY_RULE_FAILED') {
    super(message);
    this.code = code;
  }
}

const isEvidenceValid = (lot, now) => {
  const required = ['coa', 'sds', 'tds', 'lotTrace', 'inventoryProof'];
  const evidenceReady = required.every((key) => lot.evidence?.[key] === 'VALID');
  const expiresAt = lot.evidence?.expiresAt ? new Date(lot.evidence.expiresAt) : null;
  return lot.status === INVENTORY_STATES.VERIFIED_ELIGIBLE
    && evidenceReady
    && expiresAt instanceof Date
    && !Number.isNaN(expiresAt.valueOf())
    && expiresAt >= now;
};

const reservationFingerprint = (lotId, quantity, order = {}) => JSON.stringify({
  lotId: String(lotId || ''),
  quantity: Number(quantity),
  specId: String(order.specId || ''),
  deliveryDays: Number(order.deliveryDays),
});

export class EvidenceLockedInventory {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.lots = new Map();
    this.reservations = new Map();
    this.inspections = new Map();
  }

  registerLot(input = {}) {
    const lot = {
      lotId: String(input.lotId || ''),
      supplier: String(input.supplier || ''),
      supplierId: String(input.supplierId || ''),
      supplierOrganizationId: String(input.supplierOrganizationId || ''),
      specId: String(input.specId || ''),
      askPrice: Number(input.askPrice),
      currency: String(input.currency || CANONICAL_TRADE_TERMS.currency),
      priceUnit: String(input.priceUnit || CANONICAL_TRADE_TERMS.priceUnit),
      quantityUnit: String(input.quantityUnit || CANONICAL_TRADE_TERMS.quantityUnit),
      availableQty: Number(input.availableQty),
      reservedQty: Number(input.reservedQty || 0),
      status: input.status || INVENTORY_STATES.PENDING_VERIFICATION,
      evidence: clone(input.evidence || {}),
      deliveryDays: Number(input.deliveryDays),
    };
    if (!lot.lotId) throw new InventoryRuleError('로트 ID가 필요합니다.', 'LOT_ID_REQUIRED');
    if (this.lots.has(lot.lotId)) throw new InventoryRuleError('이미 등록된 로트입니다.', 'LOT_ALREADY_EXISTS');
    if (!Number.isFinite(lot.askPrice) || lot.askPrice <= 0 || !Number.isFinite(lot.availableQty) || lot.availableQty < 0 || !Number.isFinite(lot.reservedQty) || lot.reservedQty < 0 || !Number.isFinite(lot.deliveryDays) || lot.deliveryDays < 0) {
      throw new InventoryRuleError('로트 가격 또는 수량이 올바르지 않습니다.', 'INVALID_LOT');
    }
    this.lots.set(lot.lotId, lot);
    return clone(lot);
  }

  verifyLot(lot, order = {}) {
    const checks = {
      specMatch: lot.specId === order.specId,
      evidenceValid: isEvidenceValid(lot, this.now()),
      lotTraceable: Boolean(lot.lotId),
      inventoryAvailable: lot.availableQty >= order.quantity,
      deliveryFeasible: lot.deliveryDays <= order.deliveryDays,
      termsMatch: lot.currency === String(order.currency || CANONICAL_TRADE_TERMS.currency)
        && lot.priceUnit === String(order.priceUnit || CANONICAL_TRADE_TERMS.priceUnit)
        && lot.quantityUnit === String(order.quantityUnit || CANONICAL_TRADE_TERMS.quantityUnit),
    };
    return checks;
  }

  findEligible({ specId, price, quantity, deliveryDays }) {
    return [...this.lots.values()]
      .filter((lot) => {
        const checks = this.verifyLot(lot, { specId, quantity, deliveryDays });
        return lot.askPrice <= price && Object.values(checks).every(Boolean);
      })
      .sort((a, b) => a.askPrice - b.askPrice)[0] || null;
  }

  reserve(lotId, quantity, reservationId, order = {}) {
    const key = String(reservationId || '');
    if (!key) throw new InventoryRuleError('예약 ID가 필요합니다.', 'RESERVATION_ID_REQUIRED');
    const normalizedQuantity = Number(quantity);
    if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
      throw new InventoryRuleError('예약 수량은 0보다 큰 유한한 값이어야 합니다.', 'INVALID_RESERVATION_QUANTITY');
    }
    const fingerprint = reservationFingerprint(lotId, normalizedQuantity, order);
    if (this.reservations.has(key)) {
      const existingReservation = this.reservations.get(key);
      if (existingReservation.requestFingerprint && existingReservation.requestFingerprint !== fingerprint) {
        throw new InventoryRuleError('예약 ID가 다른 로트·수량·스펙 요청에 재사용되었습니다.', 'RESERVATION_ID_REUSE_MISMATCH');
      }
      if (!existingReservation.requestFingerprint && (existingReservation.lotId !== String(lotId) || Number(existingReservation.quantity) !== Number(quantity))) {
        throw new InventoryRuleError('예약 ID가 다른 로트·수량 요청에 재사용되었습니다.', 'RESERVATION_ID_REUSE_MISMATCH');
      }
      return clone({ reservation: existingReservation, lot: this.lots.get(existingReservation.lotId) });
    }
    const lot = this.lots.get(String(lotId));
    if (!lot) throw new InventoryRuleError('공급 로트를 찾을 수 없습니다.', 'LOT_NOT_FOUND');
    const checks = this.verifyLot(lot, { ...order, quantity: normalizedQuantity });
    const failed = Object.entries(checks).find(([, passed]) => !passed);
    if (failed) throw new InventoryRuleError(`거래 전 검증 실패: ${failed[0]}`, String(failed[0]).toUpperCase());
    lot.availableQty -= normalizedQuantity;
    lot.reservedQty += normalizedQuantity;
    lot.status = lot.availableQty === 0 ? INVENTORY_STATES.RESERVED : INVENTORY_STATES.VERIFIED_ELIGIBLE;
    const reservation = {
      reservationId: key,
      lotId: lot.lotId,
      quantity: normalizedQuantity,
      status: 'RESERVED',
      checks,
      requestFingerprint: fingerprint,
      reservedAt: this.now().toISOString(),
    };
    this.reservations.set(key, reservation);
    return clone({ reservation, lot });
  }

  markDelivered(reservationId) {
    const reservation = this.reservations.get(String(reservationId));
    if (!reservation) throw new InventoryRuleError('예약을 찾을 수 없습니다.', 'RESERVATION_NOT_FOUND');
    if (reservation.status !== 'RESERVED') throw new InventoryRuleError('납품 처리할 수 없는 예약입니다.', 'INVALID_DELIVERY_STATE');
    reservation.status = 'DELIVERED';
    const lot = this.lots.get(reservation.lotId);
    if (lot) lot.status = INVENTORY_STATES.DELIVERED;
    return clone({ reservation, lot });
  }

  inspect(reservationId, { specMatch = true, qualityPass = true, note = '' } = {}) {
    const reservation = this.reservations.get(String(reservationId));
    if (!reservation) throw new InventoryRuleError('예약을 찾을 수 없습니다.', 'RESERVATION_NOT_FOUND');
    if (!['RESERVED', 'DELIVERED'].includes(reservation.status)) {
      throw new InventoryRuleError('검수할 수 없는 예약 상태입니다.', 'INVALID_INSPECTION_STATE');
    }
    const passed = Boolean(specMatch && qualityPass);
    reservation.status = passed ? 'INSPECTED' : 'DISPUTED';
    const inspection = {
      reservationId: reservation.reservationId,
      specMatch: Boolean(specMatch),
      qualityPass: Boolean(qualityPass),
      status: reservation.status,
      note: String(note),
      inspectedAt: this.now().toISOString(),
    };
    this.inspections.set(reservation.reservationId, inspection);
    const lot = this.lots.get(reservation.lotId);
    if (lot) {
      // A successful inspection certifies the delivered reservation, not the
      // entire lot. Keep any unreserved remainder visible and eligible; only
      // a failed inspection quarantines the whole lot.
      lot.status = passed
        ? (lot.availableQty > 0 ? INVENTORY_STATES.VERIFIED_ELIGIBLE : INVENTORY_STATES.INSPECTED)
        : INVENTORY_STATES.QUARANTINED;
    }
    return clone({ reservation, inspection, lot });
  }

  snapshot() {
    return {
      lots: [...this.lots.values()].map(clone),
      reservations: [...this.reservations.values()].map(clone),
      inspections: [...this.inspections.values()].map(clone),
    };
  }
}
