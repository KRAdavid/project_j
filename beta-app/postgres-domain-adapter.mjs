import { createHash } from 'node:crypto';

import { reconcileDomainState } from './domain-reconciliation.mjs';
import { resolveTradeTerms } from './trade-terms.mjs';

const ACTOR_KINDS = new Set(['HUMAN', 'AI', 'SYSTEM']);
const ORDER_STATES = new Set(['SUBMITTED', 'COUNTERED', 'PARTIALLY_ACCEPTED', 'ACCEPTED']);
const REQUIRED_PRETRADE_EVIDENCE = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'];

export class PostgresDomainAdapterError extends Error {
  constructor(message, code = 'POSTGRES_DOMAIN_ADAPTER_ERROR') {
    super(message);
    this.code = code;
  }
}

const requireText = (value, name) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new PostgresDomainAdapterError(`${name}이(가) 필요합니다.`, `${name.toUpperCase()}_REQUIRED`);
  return normalized;
};

const requirePositiveNumber = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new PostgresDomainAdapterError(`${name}이(가) 올바르지 않습니다.`, `${name.toUpperCase()}_INVALID`);
  return number;
};

const actor = ({ actorKind = 'SYSTEM', actorRef, correlationId } = {}) => {
  if (!ACTOR_KINDS.has(actorKind)) throw new PostgresDomainAdapterError('actorKind가 허용 목록에 없습니다.', 'ACTOR_KIND_INVALID');
  return { actorKind, actorRef: requireText(actorRef, 'actorRef'), correlationId: requireText(correlationId, 'correlationId') };
};

const assertPhysicalMaterial = (productType = 'PHYSICAL_MATERIAL') => {
  if (productType !== 'PHYSICAL_MATERIAL') throw new PostgresDomainAdapterError('실물 원료만 정규 원장에 기록할 수 있습니다.', 'PHYSICAL_MATERIAL_ONLY');
};

const adapterTradeTerms = (input = {}) => {
  try { return resolveTradeTerms(input); } catch (error) {
    throw new PostgresDomainAdapterError(error.message, error.code);
  }
};

const assertTradeTermsEqual = (left, right) => {
  const leftTerms = adapterTradeTerms(left);
  const rightTerms = adapterTradeTerms(right);
  if (leftTerms.currency !== rightTerms.currency || leftTerms.priceUnit !== rightTerms.priceUnit || leftTerms.quantityUnit !== rightTerms.quantityUnit) {
    throw new PostgresDomainAdapterError('주문·로트·체결의 통화와 가격·수량 단위가 일치하지 않습니다.', 'TRADE_TERMS_MISMATCH');
  }
  return leftTerms;
};

const assertTradeValuesEqual = (trade, price, quantity) => {
  if (Number(trade.price) !== Number(price) || Number(trade.quantity) !== Number(quantity)) {
    throw new PostgresDomainAdapterError('가격 관측치는 체결 원장의 가격·수량과 같아야 합니다.', 'PRICE_TRADE_VALUE_MISMATCH');
  }
};

const assertInspectionRetryMatches = (inspection, { specMatch, qualityPass }) => {
  if (!inspection) throw new PostgresDomainAdapterError('완료 상태의 검수 원장을 찾을 수 없습니다.', 'INSPECTION_LEDGER_INCONSISTENT');
  if (Boolean(inspection.spec_match) !== specMatch || Boolean(inspection.quality_pass) !== qualityPass) {
    throw new PostgresDomainAdapterError('이미 종결된 검수에 다른 판정을 재사용할 수 없습니다.', 'INSPECTION_RETRY_MISMATCH');
  }
};

const assertPretradeChecks = (checks) => {
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) throw new PostgresDomainAdapterError('거래 전 검증 결과가 필요합니다.', 'PRETRADE_CHECKS_REQUIRED');
  const required = ['specMatch', 'evidenceValid', 'lotTraceable', 'inventoryAvailable'];
  const failed = required.find((key) => checks[key] !== true);
  if (failed) throw new PostgresDomainAdapterError(`거래 전 검증 실패: ${failed}`, 'PRETRADE_CHECK_FAILED');
};

const assertSnapshot = (snapshot, name) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).length === 0) {
    throw new PostgresDomainAdapterError(`${name}이(가) 봉인된 객체여야 합니다.`, `${name.toUpperCase()}_SNAPSHOT_REQUIRED`);
  }
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
};

const assertCounterRetryMatches = (existing, expected) => {
  const counter = existing?.counter_offer;
  const same = counter
    && String(counter.specId) === String(expected.specId)
    && Number(counter.price) === Number(expected.price)
    && Number(counter.quantity) === Number(expected.quantity)
    && Number(counter.deliveryDays) === Number(expected.deliveryDays)
    && String(counter.lotId) === String(expected.lotId)
    && String(counter.supplierOrganizationId) === String(expected.supplierOrganizationId)
    && JSON.stringify(canonicalize({ currency: counter.currency, priceUnit: counter.priceUnit, quantityUnit: counter.quantityUnit }))
      === JSON.stringify(canonicalize({ currency: expected.currency, priceUnit: expected.priceUnit, quantityUnit: expected.quantityUnit }));
  if (!same) throw new PostgresDomainAdapterError('이미 처리된 역제안과 다른 조건으로 재사용할 수 없습니다.', 'COUNTER_RETRY_MISMATCH');
};

const assertSpecAttributesMatch = (provided, expected) => {
  if (!provided || typeof provided !== 'object' || Array.isArray(provided) || Object.keys(provided).length === 0) throw new PostgresDomainAdapterError('정확한 원료 스펙 속성이 필요합니다. 문답으로 스펙을 확정한 뒤 주문하세요.', 'SPEC_ATTRIBUTES_REQUIRED');
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length === 0) throw new PostgresDomainAdapterError('원장에 저장된 승인 스펙 속성이 없습니다.', 'SPEC_ATTRIBUTES_UNAVAILABLE');
  if (JSON.stringify(canonicalize(provided)) !== JSON.stringify(canonicalize(expected))) throw new PostgresDomainAdapterError('주문 스펙 속성이 승인된 Material Master 스펙과 일치하지 않습니다.', 'SPEC_ATTRIBUTES_MISMATCH');
};

const assertIdempotentOrderMatches = (existing, expected) => {
  const same = String(existing.spec_id) === String(expected.specId)
    && JSON.stringify(canonicalize(existing.spec_attributes || {})) === JSON.stringify(canonicalize(expected.specAttributes || {}))
    && Number(existing.bid_price) === Number(expected.bidPrice)
    && Number(existing.requested_quantity) === Number(expected.requestedQuantity)
    && String(existing.delivery_deadline) === String(expected.deliveryDeadline)
    && Boolean(existing.partial_fill_allowed) === Boolean(expected.partialFillAllowed);
  if (!same) throw new PostgresDomainAdapterError('같은 멱등 키로 다른 주문 내용을 재사용할 수 없습니다.', 'IDEMPOTENCY_KEY_REUSED');
};

const loadApprovedSpecification = async (client, specId) => {
  const result = await client.query("SELECT spec_id, attributes FROM specifications WHERE spec_id = $1 AND status = 'APPROVED' LIMIT 1", [requireText(specId, 'specId')]);
  if (!result.rows.length) throw new PostgresDomainAdapterError('승인된 원료 스펙이 아닙니다.', 'SPECIFICATION_NOT_APPROVED');
  return result.rows[0];
};

const mapEvidence = (row) => ({
  evidenceId: row.evidence_id,
  lotId: row.lot_id,
  evidenceType: row.evidence_type,
  documentVersion: row.document_version,
  contentSha256: row.content_sha256,
  storageRef: row.storage_ref,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  state: row.state,
  organizationId: row.organization_id || null,
  submittedBy: row.submitted_by || null,
  reviewedBy: row.reviewed_by || null,
  reviewedAt: row.reviewed_at,
});

const mapLot = (row) => ({
  lotId: row.lot_id,
  supplier: row.supplier_name || row.supplier_organization_id,
  supplierOrganizationId: row.supplier_organization_id,
  specId: row.spec_id,
  askPrice: Number(row.ask_price),
  currency: row.currency || 'KRW',
  priceUnit: row.price_unit || 'KRW_PER_KG',
  quantityUnit: row.quantity_unit || 'KG',
  availableQty: Number(row.available_quantity),
  reservedQty: Number(row.reserved_quantity),
  status: row.state,
  deliveryDays: Number(row.delivery_days),
  evidence: row.evidence || {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapOrder = (row) => ({
  orderId: row.order_id,
  buyerOrganizationId: row.buyer_organization_id,
  specId: row.spec_id,
  specAttributes: row.spec_attributes || null,
  price: Number(row.bid_price),
  quantity: Number(row.requested_quantity),
  currency: row.currency || 'KRW',
  priceUnit: row.price_unit || 'KRW_PER_KG',
  quantityUnit: row.quantity_unit || 'KG',
  deliveryDate: row.delivery_deadline,
  deliveryDays: row.delivery_days === null || row.delivery_days === undefined ? null : Number(row.delivery_days),
  status: row.state,
  partialFillAllowed: row.partial_fill_allowed,
  counterOffer: row.counter_offer || null,
  expiresAt: row.expires_at,
  idempotencyKey: row.idempotency_key || null,
  createdAt: row.created_at,
});

const mapTrade = (row) => ({
  tradeId: row.trade_id,
  orderId: row.order_id,
  supplierOrganizationId: row.supplier_organization_id,
  buyerOrganizationId: row.buyer_organization_id,
  lotId: row.lot_id,
  specId: row.spec_id,
  status: row.state,
  price: Number(row.price),
  quantity: Number(row.quantity),
  currency: row.currency || 'KRW',
  priceUnit: row.price_unit || 'KRW_PER_KG',
  quantityUnit: row.quantity_unit || 'KG',
  deliveryDate: row.delivery_deadline,
  specSnapshot: row.spec_snapshot,
  lotSnapshot: row.lot_snapshot,
  evidenceSnapshot: row.evidence_snapshot,
  preTradeChecks: row.pretrade_checks,
  tradeSnapshotHash: row.trade_snapshot_hash,
  confirmedAt: row.confirmed_at,
  fulfilledAt: row.completed_at,
});

const mapReservation = (row) => ({
  reservationId: row.reservation_id,
  orderId: row.order_id,
  lotId: row.lot_id,
  quantity: Number(row.quantity),
  status: row.state,
  reservedAt: row.reserved_at,
  releasedAt: row.released_at,
});

const mapInspection = (row) => ({
  tradeId: row.trade_id,
  reservationId: row.reservation_id,
  status: row.state,
  specMatch: row.spec_match,
  qualityPass: row.quality_pass,
  note: row.note,
  inspectedBy: row.inspected_by,
  inspectedAt: row.inspected_at,
});

const OPERATIONAL_DECISION_STATUS = {
  approve: 'APPROVED',
  request_changes: 'CHANGES_REQUESTED',
  hold: 'HELD',
  reject: 'REJECTED',
};

const mapOperationalApproval = (row) => ({
  approvalId: row.approval_id,
  taskId: row.task_id,
  sourceRunId: row.source_run_id,
  requiredPrincipal: row.required_principal,
  objective: row.objective,
  risk: row.risk,
  reviewers: row.reviewers || [],
  status: row.state,
  decision: row.decision,
  decisionNote: row.decision_note || '',
  decidedBy: row.decided_by,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
});

const mapSupplierVerificationRequest = (row) => ({
  requestId: row.request_id,
  approvalId: row.approval_id,
  organizationId: row.organization_id,
  organizationName: row.legal_name || null,
  requestedBy: row.requested_by,
  businessRegistrationRef: row.business_registration_ref,
  evidenceRefs: row.evidence_refs || {},
  status: row.state,
  approvalStatus: row.approval_state || null,
  decisionNote: row.decision_note || '',
  decidedBy: row.decided_by,
  requestedAt: row.requested_at,
  decidedAt: row.decided_at,
});

export class PostgresDomainAdapter {
  constructor(pool) {
    if (!pool || typeof pool.connect !== 'function') throw new PostgresDomainAdapterError('PostgreSQL pool이 필요합니다.', 'POSTGRES_POOL_REQUIRED');
    this.pool = pool;
    this.mode = 'postgresql-domain';
  }

  async withTransaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async state() {
    const [materials, specifications, lots, evidence, orders, reservations, trades, inspections, events] = await Promise.all([
      this.pool.query("SELECT material_id, canonical_name, status FROM materials WHERE status = 'APPROVED' ORDER BY material_id"),
      this.pool.query("SELECT spec_id, material_id, version, status, attributes FROM specifications WHERE status = 'APPROVED' ORDER BY material_id, version"),
      this.pool.query('SELECT l.*, o.legal_name AS supplier_name, COALESCE(jsonb_object_agg(e.evidence_type, e.state) FILTER (WHERE e.evidence_id IS NOT NULL), \'{}\'::jsonb) AS evidence FROM lots l JOIN organizations o ON o.organization_id = l.supplier_organization_id LEFT JOIN evidences e ON e.lot_id = l.lot_id GROUP BY l.lot_id, o.legal_name ORDER BY l.created_at DESC'),
      this.pool.query('SELECT * FROM evidences ORDER BY created_at ASC'),
      this.pool.query('SELECT po.*, NULL::integer AS delivery_days FROM purchase_orders po ORDER BY po.created_at ASC'),
      this.pool.query('SELECT * FROM reservations ORDER BY reserved_at ASC'),
      this.pool.query('SELECT t.*, po.spec_id FROM trades t JOIN purchase_orders po ON po.order_id = t.order_id ORDER BY t.confirmed_at ASC'),
      this.pool.query('SELECT * FROM trade_inspections ORDER BY inspected_at ASC'),
      this.pool.query('SELECT event_id, trade_id, order_id, lot_id, actor_kind, actor_ref, event_type, before_state, after_state, correlation_id, created_at FROM trade_events ORDER BY created_at DESC LIMIT 100'),
    ]);
    return {
      dataStatus: 'LIVE_POSTGRESQL_LEDGER',
      material: materials.rows[0] ? { materialId: materials.rows[0].material_id, name: materials.rows[0].canonical_name } : null,
      materials: materials.rows,
      specs: specifications.rows.map((row) => ({ specId: row.spec_id, materialId: row.material_id, version: row.version, status: row.status, attributes: row.attributes })),
      lots: lots.rows.map(mapLot),
      evidence: evidence.rows.map(mapEvidence),
      orders: orders.rows.map(mapOrder),
      inventory: { lots: lots.rows.map(mapLot), reservations: reservations.rows.map(mapReservation), inspections: inspections.rows.map(mapInspection) },
      trades: trades.rows.map(mapTrade),
      events: events.rows.map((row) => ({ eventId: row.event_id, type: row.event_type, message: row.event_type, details: row.after_state || {}, actorKind: row.actor_kind, actorRef: row.actor_ref, correlationId: row.correlation_id, occurredAt: row.created_at })),
    };
  }

  async listOperationalApprovals() {
    const result = await this.pool.query('SELECT * FROM operational_approvals ORDER BY created_at DESC');
    return result.rows.map(mapOperationalApproval);
  }

  async supplierEligibility(organizationId) {
    const normalizedOrganizationId = requireText(organizationId, 'organizationId');
    const result = await this.pool.query(
      `SELECT o.organization_id, o.legal_name, o.verified_at,
              (o.verification_evidence <> '{}'::jsonb) AS has_verification_evidence,
              EXISTS (
                SELECT 1 FROM organization_members om
                WHERE om.organization_id = o.organization_id
                  AND om.role = 'SUPPLIER'::organization_member_role
                  AND om.active = true
              ) AS active_supplier_membership
         FROM organizations o
        WHERE o.organization_id = $1::uuid
        LIMIT 1`,
      [normalizedOrganizationId],
    );
    const row = result.rows[0];
    const requestResult = row
      ? await this.pool.query('SELECT * FROM supplier_verification_requests WHERE organization_id = $1::uuid ORDER BY requested_at DESC LIMIT 1', [normalizedOrganizationId])
      : { rows: [] };
    const latestVerificationRequest = requestResult.rows[0] ? mapSupplierVerificationRequest(requestResult.rows[0]) : null;
    const organizationVerified = Boolean(row?.verified_at && row?.has_verification_evidence);
    const activeSupplierMembership = Boolean(row?.active_supplier_membership);
    const reasons = [];
    if (!row) reasons.push('공급자 조직을 찾을 수 없습니다.');
    else if (!organizationVerified) reasons.push('사업자·거래 자격 검증이 운영자에 의해 완료되지 않았습니다.');
    if (row && !activeSupplierMembership) reasons.push('활성 SUPPLIER 멤버십이 없습니다.');
    return {
      organizationId: normalizedOrganizationId,
      organizationName: row?.legal_name || null,
      organizationExists: Boolean(row),
      organizationVerified,
      activeSupplierMembership,
      eligibleToSubmitLot: organizationVerified && activeSupplierMembership,
      latestVerificationRequest,
      reasons,
      policy: {
        listingRequiresLotEvidence: true,
        requiredLotEvidence: ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'],
        aiMayAssessButNotApprove: true,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  async listSupplierVerificationRequests() {
    const result = await this.pool.query(
      `SELECT r.*, o.legal_name, a.state AS approval_state
         FROM supplier_verification_requests r
         JOIN organizations o ON o.organization_id = r.organization_id
         LEFT JOIN operational_approvals a ON a.approval_id = r.approval_id
        WHERE r.state IN ('REQUESTED'::supplier_verification_state, 'UNDER_REVIEW'::supplier_verification_state)
        ORDER BY r.requested_at DESC`,
    );
    return result.rows.map(mapSupplierVerificationRequest);
  }

  async requestSupplierVerification({ supplierOrganizationId, supplierUserId, businessRegistrationRef, evidenceRefs = {}, actorKind = 'HUMAN', actorRef, correlationId } = {}) {
    const normalizedOrganizationId = requireText(supplierOrganizationId, 'supplierOrganizationId');
    const normalizedUserId = requireText(supplierUserId, 'supplierUserId');
    const registrationRef = requireText(businessRegistrationRef, 'businessRegistrationRef');
    if (!evidenceRefs || typeof evidenceRefs !== 'object' || Array.isArray(evidenceRefs) || Object.keys(evidenceRefs).length === 0) {
      throw new PostgresDomainAdapterError('사업자·공급자 검증 증빙 참조가 필요합니다.', 'SUPPLIER_VERIFICATION_EVIDENCE_REQUIRED');
    }
    const audit = actor({ actorKind, actorRef: actorRef || normalizedUserId, correlationId });
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:supplier-verification'))");
      await this.assertMembership(client, { organizationId: normalizedOrganizationId, userId: normalizedUserId, role: 'SUPPLIER' });
      const organization = await client.query('SELECT organization_id, verified_at, verification_evidence FROM organizations WHERE organization_id = $1::uuid FOR UPDATE', [normalizedOrganizationId]);
      if (!organization.rows.length) throw new PostgresDomainAdapterError('공급자 조직을 찾을 수 없습니다.', 'SUPPLIER_ORGANIZATION_NOT_FOUND');
      const currentOrganization = organization.rows[0];
      if (currentOrganization.verified_at && currentOrganization.verification_evidence && Object.keys(currentOrganization.verification_evidence).length > 0) {
        return { request: null, status: 'ALREADY_VERIFIED', idempotent: true, correlationId: audit.correlationId };
      }
      const existing = await client.query("SELECT * FROM supplier_verification_requests WHERE organization_id = $1::uuid AND state IN ('REQUESTED'::supplier_verification_state, 'UNDER_REVIEW'::supplier_verification_state) ORDER BY requested_at DESC LIMIT 1", [normalizedOrganizationId]);
      if (existing.rows.length) return { request: mapSupplierVerificationRequest(existing.rows[0]), status: existing.rows[0].state, idempotent: true, correlationId: audit.correlationId };
      const approvalId = `SUPPLIER-VERIFY-${normalizedOrganizationId}`;
      const inserted = await client.query(
        "INSERT INTO supplier_verification_requests(approval_id, organization_id, requested_by, business_registration_ref, evidence_refs, state) VALUES ($1, $2::uuid, $3::uuid, $4, $5::jsonb, 'REQUESTED'::supplier_verification_state) RETURNING *",
        [approvalId, normalizedOrganizationId, normalizedUserId, registrationRef, JSON.stringify(evidenceRefs)],
      );
      const request = inserted.rows[0];
      await client.query(
        "INSERT INTO operational_approvals(approval_id, task_id, source_run_id, required_principal, objective, risk, reviewers, state) VALUES ($1, $2, $3, 'H-01', $4, 'critical', $5::jsonb, 'PENDING'::approval_state)",
        [approvalId, `SUPPLIER-VERIFICATION-${normalizedOrganizationId}`, audit.correlationId, '공급자 검증 증빙의 운영 검토를 시작할지 결정한다.', JSON.stringify(['AI-09 콘트라', 'AI-11 실드'])],
      );
      await client.query(
        'INSERT INTO trade_events(actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::actor_kind, $2, $3, $4::jsonb, $5)',
        [audit.actorKind, audit.actorRef, 'SUPPLIER_VERIFICATION_REQUESTED', JSON.stringify({ requestId: request.request_id, organizationId: normalizedOrganizationId, state: request.state }), audit.correlationId],
      );
      return { request: mapSupplierVerificationRequest(request), approvalId, status: request.state, idempotent: false, correlationId: audit.correlationId };
    });
  }

  async reviewSupplierVerification({ requestId, reviewerOrganizationId, reviewerUserId, decision, note = '', actorKind = 'HUMAN', actorRef, correlationId } = {}) {
    const normalizedRequestId = requireText(requestId, 'requestId');
    const normalizedReviewerOrganizationId = requireText(reviewerOrganizationId, 'reviewerOrganizationId');
    const normalizedReviewerUserId = requireText(reviewerUserId, 'reviewerUserId');
    const normalizedDecision = String(decision || '').trim().toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) throw new PostgresDomainAdapterError('공급자 검토 결정은 APPROVED 또는 REJECTED여야 합니다.', 'SUPPLIER_VERIFICATION_DECISION_INVALID');
    const audit = actor({ actorKind, actorRef: actorRef || normalizedReviewerUserId, correlationId });
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:supplier-verification'))");
      await this.assertMembership(client, { organizationId: normalizedReviewerOrganizationId, userId: normalizedReviewerUserId, role: 'OWNER' });
      const currentResult = await client.query('SELECT r.*, o.verified_at, o.verification_evidence FROM supplier_verification_requests r JOIN organizations o ON o.organization_id = r.organization_id WHERE r.request_id = $1::uuid FOR UPDATE', [normalizedRequestId]);
      if (!currentResult.rows.length) throw new PostgresDomainAdapterError('공급자 검증 요청을 찾을 수 없습니다.', 'SUPPLIER_VERIFICATION_REQUEST_NOT_FOUND');
      const current = currentResult.rows[0];
      if (!['REQUESTED', 'UNDER_REVIEW'].includes(current.state)) {
        if (current.state === normalizedDecision && String(current.decided_by) === normalizedReviewerUserId) return { request: mapSupplierVerificationRequest(current), status: current.state, idempotent: true, correlationId: audit.correlationId };
        throw new PostgresDomainAdapterError('이미 최종 검토된 공급자 요청은 다시 변경할 수 없습니다.', 'SUPPLIER_VERIFICATION_ALREADY_DECIDED');
      }
      const approval = await client.query('SELECT state FROM operational_approvals WHERE approval_id = $1 FOR UPDATE', [current.approval_id]);
      if (approval.rows[0]?.state !== 'APPROVED') throw new PostgresDomainAdapterError('H-01이 검토 진행을 승인하기 전에는 공급자 자격을 최종 검토할 수 없습니다.', 'SUPPLIER_VERIFICATION_APPROVAL_REQUIRED');
      const nextState = normalizedDecision;
      if (nextState === 'APPROVED') {
        await client.query('UPDATE organizations SET verified_at = now(), verification_evidence = $1::jsonb WHERE organization_id = $2::uuid', [JSON.stringify(current.evidence_refs || {}), current.organization_id]);
      }
      const updated = await client.query('UPDATE supplier_verification_requests SET state = $1::supplier_verification_state, decision_note = $2, decided_by = $3::uuid, decided_at = now() WHERE request_id = $4::uuid RETURNING *', [nextState, String(note || '').slice(0, 2000), normalizedReviewerUserId, normalizedRequestId]);
      await client.query('INSERT INTO trade_events(actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::actor_kind, $2, $3, $4::jsonb, $5)', [audit.actorKind, audit.actorRef, `SUPPLIER_VERIFICATION_${nextState}`, JSON.stringify({ requestId: normalizedRequestId, organizationId: current.organization_id, state: nextState }), audit.correlationId]);
      return { request: mapSupplierVerificationRequest(updated.rows[0]), status: nextState, idempotent: false, correlationId: audit.correlationId };
    });
  }

  async decideOperationalApproval({ approvalId, decision, decidedBy, note = '', actorKind = 'HUMAN', correlationId } = {}) {
    const normalizedApprovalId = requireText(approvalId, 'approvalId');
    const nextState = OPERATIONAL_DECISION_STATUS[String(decision || '').trim()];
    if (!nextState) throw new PostgresDomainAdapterError('승인 결정은 approve·request_changes·hold·reject 중 하나여야 합니다.', 'APPROVAL_DECISION_INVALID');
    const normalizedDecidedBy = requireText(decidedBy, 'decidedBy');
    const audit = actor({ actorKind, actorRef: normalizedDecidedBy, correlationId });
    const decisionNote = String(note || '').slice(0, 2000);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:approvals'))");
      const currentResult = await client.query('SELECT * FROM operational_approvals WHERE approval_id = $1 FOR UPDATE', [normalizedApprovalId]);
      if (!currentResult.rows.length) throw new PostgresDomainAdapterError('승인 대상을 찾을 수 없습니다.', 'APPROVAL_NOT_FOUND');
      const current = currentResult.rows[0];
      if (current.state !== 'PENDING') {
        if (current.state === nextState && String(current.decided_by) === normalizedDecidedBy) return { item: mapOperationalApproval(current), idempotent: true };
        throw new PostgresDomainAdapterError('이미 결정된 승인 대상은 다시 변경할 수 없습니다.', 'APPROVAL_ALREADY_DECIDED');
      }
      const updatedResult = await client.query("UPDATE operational_approvals SET state = $1::approval_state, decision = $2, decision_note = $3, decided_by = $4::uuid, decided_at = now() WHERE approval_id = $5 RETURNING *", [nextState, String(decision).trim(), decisionNote, normalizedDecidedBy, normalizedApprovalId]);
      await client.query("INSERT INTO approval_events(approval_id, actor_kind, actor_ref, previous_state, next_state, decision_note, correlation_id) VALUES ($1, $2::actor_kind, $3, $4::approval_state, $5::approval_state, $6, $7)", [normalizedApprovalId, audit.actorKind, audit.actorRef, current.state, nextState, decisionNote, audit.correlationId]);
      return { item: mapOperationalApproval(updatedResult.rows[0]), idempotent: false };
    });
  }

  async reconcileLatestBridge() {
    const bridge = await this.pool.query('SELECT snapshot_id, payload, created_at FROM ledger_snapshots ORDER BY snapshot_id DESC LIMIT 1');
    if (!bridge.rows.length) return reconcileDomainState({ domainSnapshot: await this.state() });
    const result = reconcileDomainState({ bridgeSnapshot: bridge.rows[0].payload, domainSnapshot: await this.state() });
    return { ...result, bridgeSnapshotId: bridge.rows[0].snapshot_id, bridgeCreatedAt: bridge.rows[0].created_at };
  }

  async listEvidence(lotId = '') {
    const result = await this.pool.query('SELECT e.*, COALESCE(e.organization_id, l.supplier_organization_id) AS organization_id FROM evidences e JOIN lots l ON l.lot_id = e.lot_id WHERE ($1 = \'\' OR e.lot_id = $1) ORDER BY e.created_at ASC', [String(lotId || '')]);
    return result.rows.map(mapEvidence);
  }

  async evidenceEligibility(lotId) {
    const records = await this.listEvidence(lotId);
    const today = new Date();
    const required = ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF'];
    const valid = Object.fromEntries(required.map((type) => [type, records.some((record) => record.evidenceType === type && record.state === 'VALID' && (!record.expiresAt || new Date(record.expiresAt) >= today))]));
    return { lotId: String(lotId || ''), requiredTypes: required, checks: valid, preTradeEligible: required.every((type) => valid[type]) };
  }

  async submitEvidence(input = {}) {
    const lotId = requireText(input.lotId, 'lotId');
    const evidenceType = requireText(input.evidenceType, 'evidenceType');
    const documentVersion = requireText(input.documentVersion, 'documentVersion');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const contentSha256 = requireText(input.contentSha256, 'contentSha256').toLowerCase();
    const storageRef = requireText(input.storageRef, 'storageRef');
    const audit = actor(input);
    if (!['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF', 'SUPPLIER_VERIFICATION'].includes(evidenceType)) throw new PostgresDomainAdapterError('허용되지 않은 증빙 유형입니다.', 'EVIDENCE_TYPE_NOT_ALLOWED');
    if (!/^[a-f0-9]{64}$/.test(contentSha256)) throw new PostgresDomainAdapterError('증빙 SHA-256 해시 형식이 올바르지 않습니다.', 'EVIDENCE_HASH_INVALID');
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const lot = await client.query('SELECT lot_id, supplier_organization_id FROM lots WHERE lot_id = $1 FOR UPDATE', [lotId]);
      if (!lot.rows.length) throw new PostgresDomainAdapterError('공급 로트를 찾을 수 없습니다.', 'LOT_NOT_FOUND');
      if (String(lot.rows[0].supplier_organization_id) !== supplierOrganizationId) throw new PostgresDomainAdapterError('증빙 제출 조직과 로트 공급 조직이 다릅니다.', 'SUPPLIER_ORGANIZATION_MISMATCH');
      const record = await client.query('INSERT INTO evidences(lot_id, organization_id, submitted_by, evidence_type, document_version, content_sha256, storage_ref, issued_at, expires_at, state) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9::date, \'PENDING\'::evidence_state) RETURNING *', [lotId, supplierOrganizationId, supplierUserId, evidenceType, documentVersion, contentSha256, storageRef, input.issuedAt || null, input.expiresAt || null]);
      const row = record.rows[0];
      await client.query('INSERT INTO trade_events(lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1, $2::actor_kind, $3, $4, $5::jsonb, $6)', [lotId, audit.actorKind, audit.actorRef, 'EVIDENCE_SUBMITTED', JSON.stringify({ evidenceId: row.evidence_id, evidenceType, state: row.state }), audit.correlationId]);
      return { evidence: mapEvidence(row), correlationId: audit.correlationId };
    });
  }

  async reviewEvidence(input = {}) {
    const evidenceId = requireText(input.evidenceId, 'evidenceId');
    const operatorOrganizationId = requireText(input.operatorOrganizationId, 'operatorOrganizationId');
    const operatorUserId = requireText(input.operatorUserId, 'operatorUserId');
    const decision = requireText(input.decision, 'decision');
    const audit = actor(input);
    if (!['VALID', 'REJECTED'].includes(decision)) throw new PostgresDomainAdapterError('검토 결정은 VALID 또는 REJECTED여야 합니다.', 'INVALID_REVIEW_DECISION');
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: operatorOrganizationId, userId: operatorUserId, role: 'OPERATOR' });
      const current = await client.query('SELECT * FROM evidences WHERE evidence_id = $1::uuid FOR UPDATE', [evidenceId]);
      if (!current.rows.length) throw new PostgresDomainAdapterError('증빙을 찾을 수 없습니다.', 'EVIDENCE_NOT_FOUND');
      if (current.rows[0].state !== 'PENDING') {
        if (current.rows[0].state === decision && String(current.rows[0].reviewed_by) === operatorUserId) return { evidence: mapEvidence(current.rows[0]), lot: null, offer: null, preTradeEligible: false, correlationId: audit.correlationId, idempotent: true };
        throw new PostgresDomainAdapterError('이미 검토된 증빙은 다른 결정으로 변경할 수 없습니다.', 'EVIDENCE_REVIEW_RETRY_MISMATCH');
      }
      const updated = await client.query('UPDATE evidences SET state = $2::evidence_state, reviewed_by = $3::uuid, reviewed_at = now() WHERE evidence_id = $1::uuid RETURNING *', [evidenceId, decision, operatorUserId]);
      const row = updated.rows[0];
      await client.query('INSERT INTO trade_events(lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1, $2::actor_kind, $3, $4, $5::jsonb, $6)', [row.lot_id, audit.actorKind, audit.actorRef, 'EVIDENCE_REVIEWED', JSON.stringify({ evidenceId, state: decision, reviewedBy: operatorUserId }), audit.correlationId]);
      let promotedLot = null;
      let offer = null;
      if (decision === 'VALID') {
        const eligibility = await client.query("SELECT count(DISTINCT evidence_type)::int AS valid_count, min(expires_at) AS expires_at FROM evidences WHERE lot_id = $1 AND state = 'VALID'::evidence_state AND (expires_at IS NULL OR expires_at >= CURRENT_DATE) AND evidence_type = ANY($2::text[])", [row.lot_id, REQUIRED_PRETRADE_EVIDENCE]);
        if (Number(eligibility.rows[0]?.valid_count || 0) === REQUIRED_PRETRADE_EVIDENCE.length) {
          const lotResult = await client.query("UPDATE lots SET state = 'VERIFIED_ELIGIBLE'::lot_state, updated_at = now() WHERE lot_id = $1 AND state = 'PENDING_VERIFICATION'::lot_state RETURNING *", [row.lot_id]);
          if (lotResult.rows[0]) {
            promotedLot = lotResult.rows[0];
            const offerResult = await client.query("INSERT INTO offers(lot_id, spec_id, state, visible_quantity, price, valid_until) SELECT lot_id, spec_id, 'VISIBLE'::offer_state, available_quantity, ask_price, $2::date FROM lots WHERE lot_id = $1 AND state = 'VERIFIED_ELIGIBLE'::lot_state AND NOT EXISTS (SELECT 1 FROM offers WHERE lot_id = $1 AND state = 'VISIBLE'::offer_state) RETURNING *", [row.lot_id, eligibility.rows[0]?.expires_at || null]);
            offer = offerResult.rows[0] || null;
            await client.query('INSERT INTO trade_events(lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1, $2::actor_kind, $3, $4, $5::jsonb, $6)', [row.lot_id, audit.actorKind, audit.actorRef, 'LOT_VERIFIED', JSON.stringify({ state: 'VERIFIED_ELIGIBLE', evidenceTypes: REQUIRED_PRETRADE_EVIDENCE }), audit.correlationId]);
          }
        }
      }
      if (promotedLot) promotedLot.supplier_name = promotedLot.supplier_name || promotedLot.supplier_organization_id;
      return { evidence: mapEvidence(row), lot: promotedLot ? mapLot(promotedLot) : null, offer, preTradeEligible: Boolean(promotedLot && offer), correlationId: audit.correlationId };
    });
  }

  async assertMembership(client, { organizationId, userId, role }) {
    const result = await client.query(
      'SELECT 1 FROM organization_members WHERE organization_id = $1::uuid AND user_id = $2::uuid AND role = $3::organization_member_role AND active = true LIMIT 1',
      [requireText(organizationId, 'organizationId'), requireText(userId, 'userId'), requireText(role, 'role')],
    );
    if (!result.rows.length) throw new PostgresDomainAdapterError('조직의 활성 멤버십을 확인할 수 없습니다.', 'ORGANIZATION_MEMBERSHIP_REQUIRED');
  }

  async assertOrganizationRole(client, { organizationId, role }) {
    const result = await client.query('SELECT 1 FROM organization_members WHERE organization_id = $1::uuid AND role = $2::organization_member_role AND active = true LIMIT 1', [requireText(organizationId, 'organizationId'), requireText(role, 'role')]);
    if (!result.rows.length) throw new PostgresDomainAdapterError('조직의 활성 역할 멤버십을 확인할 수 없습니다.', 'ORGANIZATION_ROLE_REQUIRED');
  }

  async assertVerifiedSupplierOrganization(client, organizationId) {
    const result = await client.query("SELECT organization_id FROM organizations WHERE organization_id = $1::uuid AND verified_at IS NOT NULL AND verification_evidence <> '{}'::jsonb LIMIT 1", [requireText(organizationId, 'organizationId')]);
    if (!result.rows.length) throw new PostgresDomainAdapterError('공급자 조직의 사업자·거래 자격 검증이 완료되지 않았습니다.', 'SUPPLIER_ORGANIZATION_NOT_VERIFIED');
  }

  async submitOrder(input = {}) {
    assertPhysicalMaterial(input.productType);
    const buyerOrganizationId = requireText(input.buyerOrganizationId, 'buyerOrganizationId');
    const specId = requireText(input.specId, 'specId');
    const bidPrice = requirePositiveNumber(input.bidPrice, 'bidPrice');
    const requestedQuantity = requirePositiveNumber(input.requestedQuantity, 'requestedQuantity');
    const tradeTerms = adapterTradeTerms(input);
    const deliveryDeadline = requireText(input.deliveryDeadline, 'deliveryDeadline');
    const userId = requireText(input.userId, 'userId');
    const idempotencyKey = String(input.idempotencyKey || '').trim() || null;
    const audit = actor(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: buyerOrganizationId, userId, role: 'BUYER' });
      const specification = await loadApprovedSpecification(client, specId);
      assertSpecAttributesMatch(input.specAttributes, specification.attributes);
      if (idempotencyKey) {
        const existing = await client.query(
          'SELECT * FROM purchase_orders WHERE buyer_organization_id = $1::uuid AND idempotency_key = $2 FOR UPDATE',
          [buyerOrganizationId, idempotencyKey],
        );
        if (existing.rows.length) {
          assertIdempotentOrderMatches(existing.rows[0], {
            specId,
            specAttributes: specification.attributes,
            bidPrice,
            requestedQuantity,
            deliveryDeadline,
            partialFillAllowed: input.partialFillAllowed !== false,
          });
          return { order: existing.rows[0], correlationId: audit.correlationId, idempotent: true };
        }
      }
      const order = await client.query(
        'INSERT INTO purchase_orders(buyer_organization_id, spec_id, spec_attributes, product_type, state, bid_price, currency, price_unit, quantity_unit, requested_quantity, delivery_deadline, partial_fill_allowed, idempotency_key, expires_at) VALUES ($1::uuid, $2, $3::jsonb, \'PHYSICAL_MATERIAL\', \'SUBMITTED\', $4, $5, $6, $7, $8, $9::date, $10, $11, $12::timestamptz) RETURNING *',
        [buyerOrganizationId, specId, JSON.stringify(specification.attributes), bidPrice, tradeTerms.currency, tradeTerms.priceUnit, tradeTerms.quantityUnit, requestedQuantity, deliveryDeadline, input.partialFillAllowed !== false, idempotencyKey, input.expiresAt || null],
      );
      const row = order.rows[0];
      await client.query(
        'INSERT INTO trade_events(order_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2::actor_kind, $3, $4, $5::jsonb, $6)',
        [row.order_id, audit.actorKind, audit.actorRef, 'ORDER_SUBMITTED', JSON.stringify({ state: row.state, specId, bidPrice, requestedQuantity }), audit.correlationId],
      );
      return { order: row, correlationId: audit.correlationId, idempotent: false };
    });
  }

  async reserveInventory(input = {}) {
    const orderId = requireText(input.orderId, 'orderId');
    const lotId = requireText(input.lotId, 'lotId');
    const quantity = requirePositiveNumber(input.quantity, 'quantity');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const audit = actor(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      const orderState = await client.query('SELECT order_id, state FROM purchase_orders WHERE order_id = $1::uuid FOR UPDATE', [orderId]);
      if (!orderState.rows.length) throw new PostgresDomainAdapterError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
      if (!ORDER_STATES.has(orderState.rows[0].state)) throw new PostgresDomainAdapterError('재고 예약을 할 수 없는 주문 상태입니다.', 'ORDER_STATE_INVALID');
      const reservation = await client.query('SELECT reserve_lot($1::uuid, $2, $3::numeric, $4) AS reservation_id', [orderId, lotId, quantity, idempotencyKey]);
      const reservationId = reservation.rows[0]?.reservation_id;
      if (!reservationId) throw new PostgresDomainAdapterError('재고 예약 식별자를 반환받지 못했습니다.', 'RESERVATION_NOT_CREATED');
      const state = await client.query('SELECT reservation_id, order_id, lot_id, quantity, state FROM reservations WHERE reservation_id = $1::uuid', [reservationId]);
      const row = state.rows[0];
      await client.query(
        'INSERT INTO trade_events(order_id, lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2, $3::actor_kind, $4, $5, $6::jsonb, $7)',
        [orderId, lotId, audit.actorKind, audit.actorRef, 'INVENTORY_RESERVED', JSON.stringify(row || { reservationId, lotId, quantity }), audit.correlationId],
      );
      return { reservation: row || { reservation_id: reservationId, order_id: orderId, lot_id: lotId, quantity }, correlationId: audit.correlationId };
    });
  }

  async confirmTrade(input = {}) {
    const orderId = requireText(input.orderId, 'orderId');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const buyerOrganizationId = requireText(input.buyerOrganizationId, 'buyerOrganizationId');
    const lotId = requireText(input.lotId, 'lotId');
    const price = requirePositiveNumber(input.price, 'price');
    const quantity = requirePositiveNumber(input.quantity, 'quantity');
    const tradeTerms = adapterTradeTerms(input);
    const deliveryDeadline = requireText(input.deliveryDeadline, 'deliveryDeadline');
    const tradeSnapshotHash = requireText(input.tradeSnapshotHash, 'tradeSnapshotHash');
    const buyerUserId = requireText(input.buyerUserId, 'buyerUserId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const audit = actor(input);
    assertPretradeChecks(input.pretradeChecks);
    assertSnapshot(input.specSnapshot, 'specSnapshot');
    assertSnapshot(input.lotSnapshot, 'lotSnapshot');
    assertSnapshot(input.evidenceSnapshot, 'evidenceSnapshot');
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: buyerOrganizationId, userId: buyerUserId, role: 'BUYER' });
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const orderResult = await client.query('SELECT order_id, buyer_organization_id, spec_id, spec_attributes, state, currency, price_unit, quantity_unit FROM purchase_orders WHERE order_id = $1::uuid FOR UPDATE', [orderId]);
      const order = orderResult.rows[0];
      if (!order) throw new PostgresDomainAdapterError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
      if (String(order.buyer_organization_id) !== buyerOrganizationId) throw new PostgresDomainAdapterError('주문 구매 조직이 일치하지 않습니다.', 'BUYER_ORGANIZATION_MISMATCH');
      if (!ORDER_STATES.has(order.state)) throw new PostgresDomainAdapterError('체결할 수 없는 주문 상태입니다.', 'ORDER_STATE_INVALID');
      assertTradeTermsEqual(order, tradeTerms);
      const specification = await loadApprovedSpecification(client, order.spec_id);
      assertSpecAttributesMatch(order.spec_attributes, specification.attributes);
      if (String(input.specSnapshot.specId || '') !== String(order.spec_id)) throw new PostgresDomainAdapterError('체결 스냅샷의 스펙이 주문과 일치하지 않습니다.', 'SPEC_SNAPSHOT_MISMATCH');
      assertSpecAttributesMatch(input.specSnapshot.attributes, order.spec_attributes);
      if (String(input.lotSnapshot.lotId || '') !== lotId) throw new PostgresDomainAdapterError('체결 스냅샷의 로트가 주문과 일치하지 않습니다.', 'LOT_SNAPSHOT_MISMATCH');
      const lotResult = await client.query('SELECT lot_id, spec_id, supplier_organization_id, state, currency, price_unit, quantity_unit FROM lots WHERE lot_id = $1 FOR UPDATE', [lotId]);
      const lot = lotResult.rows[0];
      if (!lot) throw new PostgresDomainAdapterError('공급 로트를 찾을 수 없습니다.', 'LOT_NOT_FOUND');
      if (String(lot.spec_id) !== String(order.spec_id)) throw new PostgresDomainAdapterError('로트 스펙이 주문 스펙과 일치하지 않습니다.', 'LOT_SPEC_MISMATCH');
      if (String(lot.supplier_organization_id) !== supplierOrganizationId) throw new PostgresDomainAdapterError('로트 공급 조직이 일치하지 않습니다.', 'SUPPLIER_ORGANIZATION_MISMATCH');
      assertTradeTermsEqual(lot, tradeTerms);
      if (!['VERIFIED_ELIGIBLE', 'RESERVED'].includes(lot.state)) throw new PostgresDomainAdapterError('검증 적격 또는 예약 상태의 로트만 체결할 수 있습니다.', 'LOT_STATE_INVALID');
      const evidenceResult = await client.query("SELECT count(DISTINCT evidence_type)::int AS valid_count FROM evidences WHERE lot_id = $1 AND state = 'VALID'::evidence_state AND (expires_at IS NULL OR expires_at >= CURRENT_DATE) AND evidence_type = ANY($2::text[])", [lotId, REQUIRED_PRETRADE_EVIDENCE]);
      if (Number(evidenceResult.rows[0]?.valid_count || 0) !== REQUIRED_PRETRADE_EVIDENCE.length) throw new PostgresDomainAdapterError('로트의 거래 전 필수 증빙이 모두 유효하지 않습니다.', 'PRETRADE_EVIDENCE_REQUIRED');
      const reservation = await client.query("SELECT reservation_id, quantity FROM reservations WHERE order_id = $1::uuid AND lot_id = $2 AND state = 'ACTIVE'::reservation_state FOR UPDATE", [orderId, lotId]);
      if (!reservation.rows.length || Number(reservation.rows[0].quantity) < quantity) throw new PostgresDomainAdapterError('활성 재고 예약이 체결 수량을 충족하지 않습니다.', 'RESERVATION_REQUIRED');
      const trade = await client.query(
        'INSERT INTO trades(order_id, supplier_organization_id, buyer_organization_id, lot_id, state, price, quantity, currency, price_unit, quantity_unit, delivery_deadline, spec_snapshot, lot_snapshot, evidence_snapshot, pretrade_checks, trade_snapshot_hash) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, \'CONFIRMED\', $5, $6, $7, $8, $9, $10::date, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15) RETURNING *',
        [orderId, supplierOrganizationId, buyerOrganizationId, lotId, price, quantity, tradeTerms.currency, tradeTerms.priceUnit, tradeTerms.quantityUnit, deliveryDeadline, JSON.stringify(input.specSnapshot), JSON.stringify(input.lotSnapshot), JSON.stringify(input.evidenceSnapshot), JSON.stringify(input.pretradeChecks), tradeSnapshotHash],
      );
      await client.query("UPDATE purchase_orders SET state = 'TRADE_CONFIRMED'::order_state WHERE order_id = $1::uuid", [orderId]);
      const row = trade.rows[0];
      await client.query(
        'INSERT INTO trade_events(trade_id, order_id, lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2::uuid, $3, $4::actor_kind, $5, $6, $7::jsonb, $8)',
        [row.trade_id, orderId, lotId, audit.actorKind, audit.actorRef, 'TRADE_CONFIRMED', JSON.stringify({ state: row.state, price, quantity, tradeSnapshotHash }), audit.correlationId],
      );
      return { trade: row, reservation: reservation.rows[0], correlationId: audit.correlationId };
    });
  }

  async acceptOrder(input = {}) {
    const orderId = requireText(input.orderId, 'orderId');
    const lotId = requireText(input.lotId, 'lotId');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const acceptedQuantity = requirePositiveNumber(input.acceptedQuantity || input.quantity, 'acceptedQuantity');
    const audit = actor(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertVerifiedSupplierOrganization(client, supplierOrganizationId);
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const orderResult = await client.query('SELECT * FROM purchase_orders WHERE order_id = $1::uuid FOR UPDATE', [orderId]);
      const order = orderResult.rows[0];
      if (!order) throw new PostgresDomainAdapterError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
      if (acceptedQuantity > Number(order.requested_quantity)) throw new PostgresDomainAdapterError('수락 수량이 주문 수량을 초과합니다.', 'INVALID_ACCEPTED_QUANTITY');
      await this.assertOrganizationRole(client, { organizationId: order.buyer_organization_id, role: 'BUYER' });
      const existingTradeResult = await client.query('SELECT t.*, po.spec_id FROM trades t JOIN purchase_orders po ON po.order_id = t.order_id WHERE t.order_id = $1::uuid AND t.lot_id = $2 FOR UPDATE', [orderId, lotId]);
      if (existingTradeResult.rows.length) {
        const existingTrade = existingTradeResult.rows[0];
        if (String(existingTrade.supplier_organization_id) !== supplierOrganizationId || String(existingTrade.spec_id || order.spec_id) !== String(order.spec_id) || Number(existingTrade.quantity) !== acceptedQuantity || Number(existingTrade.price) !== Number(order.bid_price)) {
          throw new PostgresDomainAdapterError('이미 처리된 공급자 수락과 다른 조건으로 재사용할 수 없습니다.', 'ACCEPT_RETRY_MISMATCH');
        }
        const existingReservation = await client.query("SELECT reservation_id, quantity, state FROM reservations WHERE order_id = $1::uuid AND lot_id = $2 ORDER BY reserved_at DESC LIMIT 1", [orderId, lotId]);
        return { order, trade: existingTrade, reservation: existingReservation.rows[0] || null, correlationId: audit.correlationId, idempotent: true };
      }
      if (!['SUBMITTED', 'COUNTERED'].includes(order.state)) throw new PostgresDomainAdapterError('체결할 수 없는 주문 상태입니다.', 'ORDER_STATE_INVALID');
      const specification = await loadApprovedSpecification(client, order.spec_id);
      assertSpecAttributesMatch(order.spec_attributes, specification.attributes);
      const lotResult = await client.query('SELECT l.*, o.legal_name AS supplier_name FROM lots l JOIN organizations o ON o.organization_id = l.supplier_organization_id WHERE l.lot_id = $1 FOR UPDATE', [lotId]);
      const lot = lotResult.rows[0];
      if (!lot) throw new PostgresDomainAdapterError('공급 로트를 찾을 수 없습니다.', 'LOT_NOT_FOUND');
      if (String(lot.supplier_organization_id) !== supplierOrganizationId) throw new PostgresDomainAdapterError('로트 공급 조직이 일치하지 않습니다.', 'SUPPLIER_ORGANIZATION_MISMATCH');
      if (String(lot.spec_id) !== String(order.spec_id)) throw new PostgresDomainAdapterError('로트 스펙이 주문 스펙과 일치하지 않습니다.', 'LOT_SPEC_MISMATCH');
      const tradeTerms = assertTradeTermsEqual(order, lot);
      if (!['VERIFIED_ELIGIBLE', 'RESERVED'].includes(lot.state)) throw new PostgresDomainAdapterError('검증 적격 또는 예약 상태의 로트만 체결할 수 있습니다.', 'LOT_STATE_INVALID');
      const evidenceResult = await client.query("SELECT evidence_type, state, content_sha256, storage_ref, document_version, expires_at FROM evidences WHERE lot_id = $1 AND state = 'VALID'::evidence_state AND (expires_at IS NULL OR expires_at >= CURRENT_DATE) AND evidence_type = ANY($2::text[]) ORDER BY evidence_type, created_at DESC", [lotId, REQUIRED_PRETRADE_EVIDENCE]);
      const latestEvidence = new Map();
      for (const row of evidenceResult.rows) if (!latestEvidence.has(row.evidence_type)) latestEvidence.set(row.evidence_type, row);
      if (latestEvidence.size !== REQUIRED_PRETRADE_EVIDENCE.length) throw new PostgresDomainAdapterError('로트의 거래 전 필수 증빙이 모두 유효하지 않습니다.', 'PRETRADE_EVIDENCE_REQUIRED');
      const reservationResult = await client.query('SELECT reserve_lot($1::uuid, $2, $3::numeric, $4) AS reservation_id', [orderId, lotId, acceptedQuantity, String(input.idempotencyKey || `RESERVE-${orderId}-${lotId}-${acceptedQuantity}`)]);
      const reservationId = reservationResult.rows[0]?.reservation_id;
      if (!reservationId) throw new PostgresDomainAdapterError('재고 예약 식별자를 반환받지 못했습니다.', 'RESERVATION_NOT_CREATED');
      const specSnapshot = input.specSnapshot || { specId: order.spec_id, attributes: order.spec_attributes };
      if (String(specSnapshot.specId || '') !== String(order.spec_id)) throw new PostgresDomainAdapterError('체결 스냅샷의 스펙이 주문과 일치하지 않습니다.', 'SPEC_SNAPSHOT_MISMATCH');
      assertSpecAttributesMatch(specSnapshot.attributes, order.spec_attributes);
      const lotSnapshot = input.lotSnapshot || { lotId, supplierOrganizationId, quantity: acceptedQuantity, askPrice: Number(lot.ask_price), ...tradeTerms };
      const evidenceSnapshot = input.evidenceSnapshot || Object.fromEntries([...latestEvidence.entries()].map(([type, row]) => [type, { state: row.state, contentSha256: row.content_sha256, storageRef: row.storage_ref, documentVersion: row.document_version, expiresAt: row.expires_at }]));
      const pretradeChecks = { specMatch: true, evidenceValid: true, lotTraceable: true, inventoryAvailable: true };
      const tradeSnapshotHash = input.tradeSnapshotHash || createHash('sha256').update(JSON.stringify({ orderId, lotId, price: Number(order.bid_price), quantity: acceptedQuantity, tradeTerms, specSnapshot, lotSnapshot, evidenceSnapshot, pretradeChecks })).digest('hex');
      const tradeResult = await client.query(
        'INSERT INTO trades(order_id, supplier_organization_id, buyer_organization_id, lot_id, state, price, quantity, currency, price_unit, quantity_unit, delivery_deadline, spec_snapshot, lot_snapshot, evidence_snapshot, pretrade_checks, trade_snapshot_hash) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, \'CONFIRMED\', $5, $6, $7, $8, $9, $10::date, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15) RETURNING *',
        [orderId, supplierOrganizationId, order.buyer_organization_id, lotId, order.bid_price, acceptedQuantity, tradeTerms.currency, tradeTerms.priceUnit, tradeTerms.quantityUnit, order.delivery_deadline, JSON.stringify(specSnapshot), JSON.stringify(lotSnapshot), JSON.stringify(evidenceSnapshot), JSON.stringify(pretradeChecks), tradeSnapshotHash],
      );
      await client.query("UPDATE purchase_orders SET state = 'TRADE_CONFIRMED'::order_state WHERE order_id = $1::uuid", [orderId]);
      const row = tradeResult.rows[0];
      row.spec_id = order.spec_id;
      await client.query(
        'INSERT INTO trade_events(trade_id, order_id, lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2::uuid, $3, $4::actor_kind, $5, $6, $7::jsonb, $8)',
        [row.trade_id, orderId, lotId, audit.actorKind, audit.actorRef, 'TRADE_CONFIRMED', JSON.stringify({ state: row.state, price: row.price, quantity: row.quantity, reservationId, tradeSnapshotHash }), audit.correlationId],
      );
      return { order, trade: row, reservation: { reservation_id: reservationId, quantity: acceptedQuantity, state: 'ACTIVE' }, correlationId: audit.correlationId };
    });
  }

  async counterOrder(input = {}) {
    const orderId = requireText(input.orderId, 'orderId');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const lotId = requireText(input.lotId, 'lotId');
    const price = requirePositiveNumber(input.price, 'price');
    const quantity = requirePositiveNumber(input.quantity, 'quantity');
    const deliveryDays = Math.max(0, Math.floor(Number(input.deliveryDays || 0)));
    const tradeTerms = adapterTradeTerms(input);
    const audit = actor(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertVerifiedSupplierOrganization(client, supplierOrganizationId);
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const orderResult = await client.query('SELECT * FROM purchase_orders WHERE order_id = $1::uuid FOR UPDATE', [orderId]);
      const order = orderResult.rows[0];
      if (!order) throw new PostgresDomainAdapterError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
      if (order.state === 'COUNTERED') {
        assertCounterRetryMatches(order, { specId: order.spec_id, price, quantity, deliveryDays, lotId, supplierOrganizationId, ...tradeTerms });
        return { order, counterOffer: order.counter_offer, correlationId: audit.correlationId, idempotent: true };
      }
      if (order.state !== 'SUBMITTED') throw new PostgresDomainAdapterError('역제안할 수 없는 주문 상태입니다.', 'ORDER_STATE_INVALID');
      if (quantity > Number(order.requested_quantity)) throw new PostgresDomainAdapterError('역제안 수량이 원주문 수량을 초과합니다.', 'INVALID_COUNTER_QUANTITY');
      const lotResult = await client.query('SELECT l.*, o.legal_name AS supplier_name FROM lots l JOIN organizations o ON o.organization_id = l.supplier_organization_id WHERE l.lot_id = $1 FOR UPDATE', [lotId]);
      const lot = lotResult.rows[0];
      if (!lot) throw new PostgresDomainAdapterError('공급 로트를 찾을 수 없습니다.', 'LOT_NOT_FOUND');
      if (String(lot.supplier_organization_id) !== supplierOrganizationId || String(lot.spec_id) !== String(order.spec_id)) throw new PostgresDomainAdapterError('역제안 로트의 공급 조직 또는 스펙이 주문과 일치하지 않습니다.', 'COUNTER_LOT_MISMATCH');
      assertTradeTermsEqual(order, tradeTerms);
      assertTradeTermsEqual(lot, tradeTerms);
      if (!['VERIFIED_ELIGIBLE', 'RESERVED'].includes(lot.state) || Number(lot.available_quantity) < quantity || Number(lot.delivery_days) > deliveryDays) throw new PostgresDomainAdapterError('역제안 조건을 충족하는 검증 로트가 없습니다.', 'NO_ELIGIBLE_COUNTER_OFFER');
      const counterOffer = { specId: order.spec_id, price, quantity, deliveryDays, ...tradeTerms, lotId, supplierOrganizationId, createdAt: new Date().toISOString() };
      const updated = await client.query("UPDATE purchase_orders SET state = 'COUNTERED'::order_state, counter_offer = $2::jsonb WHERE order_id = $1::uuid RETURNING *", [orderId, JSON.stringify(counterOffer)]);
      await client.query('INSERT INTO trade_events(order_id, lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2, $3::actor_kind, $4, $5, $6::jsonb, $7)', [orderId, lotId, audit.actorKind, audit.actorRef, 'ORDER_COUNTERED', JSON.stringify({ state: 'COUNTERED', counterOffer }), audit.correlationId]);
      return { order: updated.rows[0], counterOffer, correlationId: audit.correlationId };
    });
  }

  async registerVerifiedLot(input = {}) {
    const lotId = requireText(input.lotId, 'lotId');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const specId = requireText(input.specId, 'specId');
    const totalQuantity = requirePositiveNumber(input.availableQty ?? input.totalQuantity, 'totalQuantity');
    const askPrice = requirePositiveNumber(input.askPrice, 'askPrice');
    const tradeTerms = adapterTradeTerms(input);
    const deliveryDays = Math.max(0, Math.floor(Number(input.deliveryDays || 0)));
    const audit = actor(input);
    const bundle = Array.isArray(input.evidenceBundle || input.evidence) ? (input.evidenceBundle || input.evidence) : [];
    const byType = new Map(bundle.map((record) => [String(record.evidenceType || record.evidence_type || ''), record]));
    if (byType.size !== REQUIRED_PRETRADE_EVIDENCE.length || REQUIRED_PRETRADE_EVIDENCE.some((type) => !byType.has(type))) throw new PostgresDomainAdapterError('로트 등록에는 5종 거래 전 증빙이 모두 필요합니다.', 'PRETRADE_EVIDENCE_REQUIRED');
    for (const type of REQUIRED_PRETRADE_EVIDENCE) {
      const record = byType.get(type);
      if (record.state !== 'VALID' || !String(record.contentSha256 || record.content_sha256 || '').match(/^[a-f0-9]{64}$/i) || !String(record.storageRef || record.storage_ref || '').trim() || !String(record.documentVersion || record.document_version || '').trim()) throw new PostgresDomainAdapterError(`로트 증빙 ${type}가 유효하지 않습니다.`, 'EVIDENCE_RECORD_INVALID');
    }
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertVerifiedSupplierOrganization(client, supplierOrganizationId);
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const specification = await client.query("SELECT spec_id FROM specifications WHERE spec_id = $1 AND status = 'APPROVED' LIMIT 1", [specId]);
      if (!specification.rows.length) throw new PostgresDomainAdapterError('승인된 원료 스펙이 아닙니다.', 'SPECIFICATION_NOT_APPROVED');
      const lotResult = await client.query("INSERT INTO lots(lot_id, supplier_organization_id, spec_id, state, total_quantity, available_quantity, ask_price, currency, price_unit, quantity_unit, delivery_days) VALUES ($1, $2::uuid, $3, 'PENDING_VERIFICATION'::lot_state, $4, $4, $5, $6, $7, $8, $9) RETURNING *", [lotId, supplierOrganizationId, specId, totalQuantity, askPrice, tradeTerms.currency, tradeTerms.priceUnit, tradeTerms.quantityUnit, deliveryDays]);
      for (const type of REQUIRED_PRETRADE_EVIDENCE) {
        const record = byType.get(type);
        await client.query('INSERT INTO evidences(lot_id, organization_id, submitted_by, evidence_type, document_version, content_sha256, storage_ref, issued_at, expires_at, state, reviewed_by, reviewed_at) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9::date, \'VALID\'::evidence_state, $3::uuid, now())', [lotId, supplierOrganizationId, supplierUserId, type, record.documentVersion || record.document_version, String(record.contentSha256 || record.content_sha256).toLowerCase(), record.storageRef || record.storage_ref, record.issuedAt || record.issued_at || null, record.expiresAt || record.expires_at || null]);
      }
      const expires = await client.query("SELECT min(expires_at) AS expires_at FROM evidences WHERE lot_id = $1 AND state = 'VALID'::evidence_state", [lotId]);
      const updatedLot = await client.query("UPDATE lots SET state = 'VERIFIED_ELIGIBLE'::lot_state, updated_at = now() WHERE lot_id = $1 RETURNING *", [lotId]);
      const offer = await client.query("INSERT INTO offers(lot_id, spec_id, state, visible_quantity, price, valid_until) VALUES ($1, $2, 'VISIBLE'::offer_state, $3, $4, $5::date) RETURNING *", [lotId, specId, totalQuantity, askPrice, expires.rows[0]?.expires_at || null]);
      await client.query('INSERT INTO trade_events(lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1, $2::actor_kind, $3, $4, $5::jsonb, $6)', [lotId, audit.actorKind, audit.actorRef, 'LOT_VERIFIED', JSON.stringify({ state: 'VERIFIED_ELIGIBLE', specId, evidenceTypes: REQUIRED_PRETRADE_EVIDENCE }), audit.correlationId]);
      const lot = updatedLot.rows[0];
      lot.supplier_name = input.supplier || supplierOrganizationId;
      lot.evidence = Object.fromEntries(REQUIRED_PRETRADE_EVIDENCE.map((type) => [type, 'VALID']));
      return { lot: mapLot(lot), offer: offer.rows[0], evidence: bundle, correlationId: audit.correlationId };
    });
  }

  async registerLotDraft(input = {}) {
    const lotId = requireText(input.lotId, 'lotId');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const specId = requireText(input.specId, 'specId');
    const totalQuantity = requirePositiveNumber(input.availableQty ?? input.totalQuantity, 'totalQuantity');
    const askPrice = requirePositiveNumber(input.askPrice, 'askPrice');
    const tradeTerms = adapterTradeTerms(input);
    const deliveryDaysNumber = Number(input.deliveryDays ?? 0);
    if (!Number.isFinite(deliveryDaysNumber) || deliveryDaysNumber < 0) throw new PostgresDomainAdapterError('deliveryDays가 올바르지 않습니다.', 'DELIVERY_DAYS_INVALID');
    const deliveryDays = Math.floor(deliveryDaysNumber);
    const audit = actor(input);
    const bundle = Array.isArray(input.evidenceBundle || input.evidence) ? (input.evidenceBundle || input.evidence) : [];
    const byType = new Map(bundle.map((record) => [String(record.evidenceType || record.evidence_type || ''), record]));
    if (byType.size !== REQUIRED_PRETRADE_EVIDENCE.length || REQUIRED_PRETRADE_EVIDENCE.some((type) => !byType.has(type))) throw new PostgresDomainAdapterError('로트 등록에는 5종 거래 전 증빙이 모두 필요합니다.', 'PRETRADE_EVIDENCE_REQUIRED');
    for (const type of REQUIRED_PRETRADE_EVIDENCE) {
      const record = byType.get(type);
      if (!/^[a-f0-9]{64}$/i.test(String(record.contentSha256 || record.content_sha256 || '')) || !String(record.storageRef || record.storage_ref || '').trim() || !String(record.documentVersion || record.document_version || '').trim()) throw new PostgresDomainAdapterError(`로트 증빙 ${type}가 올바르지 않습니다.`, 'EVIDENCE_RECORD_INVALID');
    }
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertVerifiedSupplierOrganization(client, supplierOrganizationId);
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const specification = await client.query("SELECT spec_id FROM specifications WHERE spec_id = $1 AND status = 'APPROVED' LIMIT 1", [specId]);
      if (!specification.rows.length) throw new PostgresDomainAdapterError('승인된 원료 스펙이 아닙니다.', 'SPECIFICATION_NOT_APPROVED');
      const lotResult = await client.query("INSERT INTO lots(lot_id, supplier_organization_id, spec_id, state, total_quantity, available_quantity, ask_price, currency, price_unit, quantity_unit, delivery_days) VALUES ($1, $2::uuid, $3, 'PENDING_VERIFICATION'::lot_state, $4, $4, $5, $6, $7, $8, $9) RETURNING *", [lotId, supplierOrganizationId, specId, totalQuantity, askPrice, tradeTerms.currency, tradeTerms.priceUnit, tradeTerms.quantityUnit, deliveryDays]);
      const evidence = [];
      for (const type of REQUIRED_PRETRADE_EVIDENCE) {
        const record = byType.get(type);
        const inserted = await client.query('INSERT INTO evidences(lot_id, organization_id, submitted_by, evidence_type, document_version, content_sha256, storage_ref, issued_at, expires_at, state) VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9::date, \'PENDING\'::evidence_state) RETURNING *', [lotId, supplierOrganizationId, supplierUserId, type, record.documentVersion || record.document_version, String(record.contentSha256 || record.content_sha256).toLowerCase(), record.storageRef || record.storage_ref, record.issuedAt || record.issued_at || null, record.expiresAt || record.expires_at || null]);
        if (inserted.rows[0]) evidence.push(mapEvidence(inserted.rows[0]));
      }
      await client.query('INSERT INTO trade_events(lot_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1, $2::actor_kind, $3, $4, $5::jsonb, $6)', [lotId, audit.actorKind, audit.actorRef, 'LOT_SUBMITTED', JSON.stringify({ state: 'PENDING_VERIFICATION', specId, evidenceTypes: REQUIRED_PRETRADE_EVIDENCE }), audit.correlationId]);
      const lot = lotResult.rows[0];
      lot.supplier_name = input.supplier || supplierOrganizationId;
      return { lot: mapLot(lot), evidence, offer: null, preTradeEligible: false, correlationId: audit.correlationId };
    });
  }

  async rejectOrder(input = {}) {
    const orderId = requireText(input.orderId, 'orderId');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const audit = actor(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const orderResult = await client.query('SELECT * FROM purchase_orders WHERE order_id = $1::uuid FOR UPDATE', [orderId]);
      const order = orderResult.rows[0];
      if (!order) throw new PostgresDomainAdapterError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
      if (order.state === 'REJECTED') return { order, correlationId: audit.correlationId, idempotent: true };
      if (!['SUBMITTED', 'COUNTERED'].includes(order.state)) throw new PostgresDomainAdapterError('거절할 수 없는 주문 상태입니다.', 'ORDER_STATE_INVALID');
      const updated = await client.query("UPDATE purchase_orders SET state = 'REJECTED'::order_state WHERE order_id = $1::uuid RETURNING *", [orderId]);
      await client.query('INSERT INTO trade_events(order_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2::actor_kind, $3, $4, $5::jsonb, $6)', [orderId, audit.actorKind, audit.actorRef, 'ORDER_REJECTED', JSON.stringify({ state: 'REJECTED', reason: String(input.reason || '') }), audit.correlationId]);
      return { order: updated.rows[0], correlationId: audit.correlationId };
    });
  }

  async expireOrder(input = {}) {
    const orderId = requireText(input.orderId, 'orderId');
    const audit = actor(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      const orderResult = await client.query('SELECT * FROM purchase_orders WHERE order_id = $1::uuid FOR UPDATE', [orderId]);
      const order = orderResult.rows[0];
      if (!order) throw new PostgresDomainAdapterError('주문을 찾을 수 없습니다.', 'ORDER_NOT_FOUND');
      if (order.state === 'EXPIRED') return { order, correlationId: audit.correlationId, idempotent: true };
      if (!order.expires_at || new Date(order.expires_at) > new Date()) throw new PostgresDomainAdapterError('아직 만료되지 않은 주문입니다.', 'ORDER_NOT_EXPIRED');
      if (!['SUBMITTED', 'COUNTERED'].includes(order.state)) throw new PostgresDomainAdapterError('만료 처리할 수 없는 주문 상태입니다.', 'ORDER_STATE_INVALID');
      const updated = await client.query("UPDATE purchase_orders SET state = 'EXPIRED'::order_state WHERE order_id = $1::uuid RETURNING *", [orderId]);
      await client.query('INSERT INTO trade_events(order_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2::actor_kind, $3, $4, $5::jsonb, $6)', [orderId, audit.actorKind, audit.actorRef, 'ORDER_EXPIRED', JSON.stringify({ state: 'EXPIRED' }), audit.correlationId]);
      return { order: updated.rows[0], correlationId: audit.correlationId };
    });
  }

  async markDelivered(input = {}) {
    const tradeId = requireText(input.tradeId, 'tradeId');
    const supplierOrganizationId = requireText(input.supplierOrganizationId, 'supplierOrganizationId');
    const supplierUserId = requireText(input.supplierUserId, 'supplierUserId');
    const audit = actor(input);
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: supplierOrganizationId, userId: supplierUserId, role: 'SUPPLIER' });
      const result = await client.query("SELECT t.trade_id, t.order_id, t.lot_id, t.state, t.supplier_organization_id, t.price, t.quantity, t.completed_at, po.spec_id, r.reservation_id, r.state AS reservation_state FROM trades t JOIN purchase_orders po ON po.order_id = t.order_id JOIN reservations r ON r.order_id = t.order_id AND r.lot_id = t.lot_id WHERE t.trade_id = $1::uuid FOR UPDATE", [tradeId]);
      const trade = result.rows[0];
      if (!trade) throw new PostgresDomainAdapterError('체결을 찾을 수 없습니다.', 'TRADE_NOT_FOUND');
      if (String(trade.supplier_organization_id) !== supplierOrganizationId) throw new PostgresDomainAdapterError('체결 공급 조직이 일치하지 않습니다.', 'SUPPLIER_ORGANIZATION_MISMATCH');
      if (['DELIVERED', 'COMPLETED', 'DISPUTED'].includes(trade.state)) {
        return { trade, reservation: { reservation_id: trade.reservation_id, state: trade.reservation_state }, correlationId: audit.correlationId, idempotent: true };
      }
      if (trade.state !== 'CONFIRMED' || trade.reservation_state !== 'ACTIVE') throw new PostgresDomainAdapterError('납품 처리할 수 없는 체결 상태입니다.', 'INVALID_DELIVERY_STATE');
      const updated = await client.query("UPDATE trades SET state = 'DELIVERED'::trade_state WHERE trade_id = $1::uuid RETURNING *", [tradeId]);
      await client.query("UPDATE lots SET state = 'DELIVERED'::lot_state, updated_at = now() WHERE lot_id = $1", [trade.lot_id]);
      await client.query(
        'INSERT INTO trade_events(trade_id, order_id, lot_id, actor_kind, actor_ref, event_type, before_state, after_state, correlation_id) VALUES ($1::uuid, $2::uuid, $3, $4::actor_kind, $5, $6, $7::jsonb, $8::jsonb, $9)',
        [tradeId, trade.order_id, trade.lot_id, audit.actorKind, audit.actorRef, 'TRADE_DELIVERED', JSON.stringify({ state: trade.state }), JSON.stringify({ state: 'DELIVERED', reservationId: trade.reservation_id }), audit.correlationId],
      );
      return { trade: updated.rows[0], reservation: { reservation_id: trade.reservation_id, state: 'ACTIVE' }, correlationId: audit.correlationId };
    });
  }

  async inspectTrade(input = {}) {
    const tradeId = requireText(input.tradeId, 'tradeId');
    const operatorOrganizationId = requireText(input.operatorOrganizationId, 'operatorOrganizationId');
    const operatorUserId = requireText(input.operatorUserId, 'operatorUserId');
    const audit = actor(input);
    const specMatch = input.specMatch === undefined ? true : input.specMatch;
    const qualityPass = input.qualityPass === undefined ? true : input.qualityPass;
    if (typeof specMatch !== 'boolean' || typeof qualityPass !== 'boolean') throw new PostgresDomainAdapterError('검수 판정은 boolean이어야 합니다.', 'INSPECTION_RESULT_INVALID');
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: operatorOrganizationId, userId: operatorUserId, role: 'OPERATOR' });
      const result = await client.query("SELECT t.trade_id, t.order_id, t.lot_id, t.state, t.price, t.quantity, t.supplier_organization_id, po.spec_id, r.reservation_id, r.state AS reservation_state FROM trades t JOIN purchase_orders po ON po.order_id = t.order_id JOIN reservations r ON r.order_id = t.order_id AND r.lot_id = t.lot_id WHERE t.trade_id = $1::uuid FOR UPDATE", [tradeId]);
      const trade = result.rows[0];
      if (!trade) throw new PostgresDomainAdapterError('체결을 찾을 수 없습니다.', 'TRADE_NOT_FOUND');
      if (['COMPLETED', 'DISPUTED'].includes(trade.state)) {
        const inspection = await client.query('SELECT * FROM trade_inspections WHERE trade_id = $1::uuid FOR SHARE', [tradeId]);
        assertInspectionRetryMatches(inspection.rows[0], { specMatch, qualityPass });
        const tradeRow = { ...trade, spec_id: trade.spec_id, price: trade.price, quantity: trade.quantity, supplier_organization_id: trade.supplier_organization_id };
        return { trade: tradeRow, inspection: inspection.rows[0], correlationId: audit.correlationId, idempotent: true };
      }
      if (!['CONFIRMED', 'DELIVERED'].includes(trade.state)) throw new PostgresDomainAdapterError('검수할 수 없는 체결 상태입니다.', 'INVALID_INSPECTION_STATE');
      const nextState = specMatch && qualityPass ? 'COMPLETED' : 'DISPUTED';
      const reservationState = nextState === 'COMPLETED' ? 'CONSUMED' : 'DISPUTED';
      const lotState = nextState === 'COMPLETED' ? 'INSPECTED' : 'QUARANTINED';
      const updated = await client.query('UPDATE trades SET state = $2::trade_state, completed_at = CASE WHEN $2::trade_state = \'COMPLETED\'::trade_state THEN now() ELSE NULL END WHERE trade_id = $1::uuid RETURNING *', [tradeId, nextState]);
      await client.query('UPDATE reservations SET state = $2::reservation_state, released_at = CASE WHEN $2::reservation_state = \'DISPUTED\'::reservation_state THEN now() ELSE released_at END WHERE reservation_id = $1::uuid', [trade.reservation_id, reservationState]);
      await client.query('UPDATE lots SET state = $2::lot_state, updated_at = now() WHERE lot_id = $1', [trade.lot_id, lotState]);
      const inspection = await client.query('INSERT INTO trade_inspections(trade_id, reservation_id, spec_match, quality_pass, state, note, inspected_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid) RETURNING *', [tradeId, trade.reservation_id, specMatch, qualityPass, nextState, String(input.note || '').slice(0, 2000), operatorUserId]);
      await client.query(
        'INSERT INTO trade_events(trade_id, order_id, lot_id, actor_kind, actor_ref, event_type, before_state, after_state, correlation_id) VALUES ($1::uuid, $2::uuid, $3, $4::actor_kind, $5, $6, $7::jsonb, $8::jsonb, $9)',
        [tradeId, trade.order_id, trade.lot_id, audit.actorKind, audit.actorRef, nextState === 'COMPLETED' ? 'TRADE_INSPECTED' : 'TRADE_DISPUTED', JSON.stringify({ state: trade.state }), JSON.stringify({ state: nextState, specMatch, qualityPass }), audit.correlationId],
      );
      const tradeRow = { ...updated.rows[0], spec_id: trade.spec_id, price: trade.price, quantity: trade.quantity, supplier_organization_id: trade.supplier_organization_id };
      return { trade: tradeRow, inspection: inspection.rows[0], correlationId: audit.correlationId };
    });
  }

  async inspectTradeAndRecordPrice(input = {}) {
    const tradeId = requireText(input.tradeId, 'tradeId');
    const operatorOrganizationId = requireText(input.operatorOrganizationId, 'operatorOrganizationId');
    const operatorUserId = requireText(input.operatorUserId, 'operatorUserId');
    const audit = actor(input);
    const specMatch = input.specMatch === undefined ? true : input.specMatch;
    const qualityPass = input.qualityPass === undefined ? true : input.qualityPass;
    if (typeof specMatch !== 'boolean' || typeof qualityPass !== 'boolean') throw new PostgresDomainAdapterError('검수 판정은 boolean이어야 합니다.', 'INSPECTION_RESULT_INVALID');
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      await this.assertMembership(client, { organizationId: operatorOrganizationId, userId: operatorUserId, role: 'OPERATOR' });
      const result = await client.query("SELECT t.trade_id, t.order_id, t.lot_id, t.state, t.price, t.quantity, t.currency, t.price_unit, t.quantity_unit, t.supplier_organization_id, po.spec_id, r.reservation_id, r.state AS reservation_state FROM trades t JOIN purchase_orders po ON po.order_id = t.order_id JOIN reservations r ON r.order_id = t.order_id AND r.lot_id = t.lot_id WHERE t.trade_id = $1::uuid FOR UPDATE", [tradeId]);
      const trade = result.rows[0];
      if (!trade) throw new PostgresDomainAdapterError('체결을 찾을 수 없습니다.', 'TRADE_NOT_FOUND');
      if (['COMPLETED', 'DISPUTED'].includes(trade.state)) {
        const inspection = await client.query('SELECT * FROM trade_inspections WHERE trade_id = $1::uuid FOR SHARE', [tradeId]);
        assertInspectionRetryMatches(inspection.rows[0], { specMatch, qualityPass });
        const tradeRow = { ...trade, spec_id: trade.spec_id, price: trade.price, quantity: trade.quantity, supplier_organization_id: trade.supplier_organization_id };
        if (trade.state === 'DISPUTED') return { trade: tradeRow, inspection: inspection.rows[0], observation: null, correlationId: audit.correlationId, idempotent: true };
        const specId = requireText(input.specId || trade.spec_id, 'specId');
        if (String(specId) !== String(trade.spec_id)) throw new PostgresDomainAdapterError('재시도 스펙이 기존 체결과 일치하지 않습니다.', 'PRICE_SPEC_MISMATCH');
        const price = requirePositiveNumber(input.price ?? trade.price, 'price');
        const quantity = requirePositiveNumber(input.quantity ?? trade.quantity, 'quantity');
        assertTradeValuesEqual(trade, price, quantity);
        const observationId = requireText(input.observationId || tradeId, 'observationId');
        const observation = await client.query('SELECT * FROM price_observations WHERE observation_id = $1 AND trade_id = $2::uuid FOR SHARE', [observationId, tradeId]);
        if (!observation.rows[0]) throw new PostgresDomainAdapterError('완료 체결의 가격 관측 원장을 찾을 수 없습니다.', 'PRICE_OBSERVATION_MISSING');
        return { trade: tradeRow, inspection: inspection.rows[0], observation: observation.rows[0], priceObservationIdempotent: true, correlationId: audit.correlationId, idempotent: true };
      }
      if (!['CONFIRMED', 'DELIVERED'].includes(trade.state)) throw new PostgresDomainAdapterError('검수할 수 없는 체결 상태입니다.', 'INVALID_INSPECTION_STATE');
      const tradeTerms = assertTradeTermsEqual(trade, input);
      const nextState = specMatch && qualityPass ? 'COMPLETED' : 'DISPUTED';
      const reservationState = nextState === 'COMPLETED' ? 'CONSUMED' : 'DISPUTED';
      const lotState = nextState === 'COMPLETED' ? 'INSPECTED' : 'QUARANTINED';
      const updated = await client.query('UPDATE trades SET state = $2::trade_state, completed_at = CASE WHEN $2::trade_state = \'COMPLETED\'::trade_state THEN now() ELSE NULL END WHERE trade_id = $1::uuid RETURNING *', [tradeId, nextState]);
      await client.query('UPDATE reservations SET state = $2::reservation_state, released_at = CASE WHEN $2::reservation_state = \'DISPUTED\'::reservation_state THEN now() ELSE released_at END WHERE reservation_id = $1::uuid', [trade.reservation_id, reservationState]);
      await client.query('UPDATE lots SET state = $2::lot_state, updated_at = now() WHERE lot_id = $1', [trade.lot_id, lotState]);
      const inspection = await client.query('INSERT INTO trade_inspections(trade_id, reservation_id, spec_match, quality_pass, state, note, inspected_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid) RETURNING *', [tradeId, trade.reservation_id, specMatch, qualityPass, nextState, String(input.note || '').slice(0, 2000), operatorUserId]);
      await client.query(
        'INSERT INTO trade_events(trade_id, order_id, lot_id, actor_kind, actor_ref, event_type, before_state, after_state, correlation_id) VALUES ($1::uuid, $2::uuid, $3, $4::actor_kind, $5, $6, $7::jsonb, $8::jsonb, $9)',
        [tradeId, trade.order_id, trade.lot_id, audit.actorKind, audit.actorRef, nextState === 'COMPLETED' ? 'TRADE_INSPECTED' : 'TRADE_DISPUTED', JSON.stringify({ state: trade.state }), JSON.stringify({ state: nextState, specMatch, qualityPass }), audit.correlationId],
      );
      const tradeRow = { ...updated.rows[0], spec_id: trade.spec_id, price: trade.price, quantity: trade.quantity, supplier_organization_id: trade.supplier_organization_id };
      if (nextState !== 'COMPLETED') return { trade: tradeRow, inspection: inspection.rows[0], observation: null, correlationId: audit.correlationId };
      const specId = requireText(input.specId || trade.spec_id, 'specId');
      const price = requirePositiveNumber(input.price ?? trade.price, 'price');
      const quantity = requirePositiveNumber(input.quantity ?? trade.quantity, 'quantity');
      assertTradeValuesEqual(trade, price, quantity);
      const observationId = requireText(input.observationId || tradeId, 'observationId');
      const provenance = input.provenance || { source: 'COMPLETED_PHYSICAL_TRADE', tradeId, inspectionId: tradeId };
      assertSnapshot(provenance, 'provenance');
      const observation = await client.query(
        'INSERT INTO price_observations(observation_id, source_type, spec_id, supplier_id, trade_id, quote_id, price, quantity, currency, price_unit, quantity_unit, fulfilled_at, evidence_status, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14::jsonb) ON CONFLICT (observation_id) DO NOTHING RETURNING *',
        [observationId, input.sourceType || 'COMPLETED_PHYSICAL_TRADE', specId, input.supplierId || trade.supplier_organization_id, tradeId, input.quoteId || null, price, quantity, tradeTerms.currency, tradeTerms.priceUnit, tradeTerms.quantityUnit, input.fulfilledAt || new Date().toISOString().slice(0, 10), input.evidenceStatus || 'VALID', JSON.stringify({ ...provenance, ...tradeTerms })],
      );
      const priceAudit = actor({ actorKind: 'SYSTEM', actorRef: input.priceActorRef || 'AI-05', correlationId: `${audit.correlationId}:PRICE` });
      await client.query(
        'INSERT INTO trade_events(trade_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2::actor_kind, $3, $4, $5::jsonb, $6)',
        [tradeId, priceAudit.actorKind, priceAudit.actorRef, 'COMPLETED_TRADE_PRICE_RECORDED', JSON.stringify({ observationId, inserted: observation.rows.length > 0, sourceType: input.sourceType || 'COMPLETED_PHYSICAL_TRADE', specId, price, quantity }), priceAudit.correlationId],
      );
      return { trade: tradeRow, inspection: inspection.rows[0], observation: observation.rows[0] || { observation_id: observationId, trade_id: tradeId }, priceObservationIdempotent: observation.rows.length === 0, correlationId: priceAudit.correlationId };
    });
  }

  async recordCompletedTradePrice(input = {}) {
    const tradeId = requireText(input.tradeId, 'tradeId');
    const specId = requireText(input.specId, 'specId');
    const sourceType = requireText(input.sourceType || 'COMPLETED_PHYSICAL_TRADE', 'sourceType');
    const price = requirePositiveNumber(input.price, 'price');
    const quantity = requirePositiveNumber(input.quantity, 'quantity');
    const observationId = requireText(input.observationId || tradeId, 'observationId');
    const audit = actor(input);
    if (input.deliveryAndInspectionComplete !== true) throw new PostgresDomainAdapterError('납품·검수 완료 증거가 필요합니다.', 'DELIVERY_INSPECTION_REQUIRED');
    assertSnapshot(input.provenance, 'provenance');
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:domain-ledger'))");
      const trade = await client.query("SELECT t.trade_id, t.state, t.price, t.quantity, t.currency, t.price_unit, t.quantity_unit, po.spec_id FROM trades t JOIN purchase_orders po ON po.order_id = t.order_id WHERE t.trade_id = $1::uuid FOR UPDATE", [tradeId]);
      if (!trade.rows.length) throw new PostgresDomainAdapterError('체결을 찾을 수 없습니다.', 'TRADE_NOT_FOUND');
      if (trade.rows[0].state !== 'COMPLETED') throw new PostgresDomainAdapterError('완료된 실물 거래만 가격 관측치가 될 수 있습니다.', 'TRADE_NOT_COMPLETED');
      if (String(trade.rows[0].spec_id || specId) !== specId) throw new PostgresDomainAdapterError('가격 관측치의 스펙이 체결 원장과 일치하지 않습니다.', 'PRICE_SPEC_MISMATCH');
      const tradeTerms = assertTradeTermsEqual(trade.rows[0], input);
      assertTradeValuesEqual(trade.rows[0], price, quantity);
      const observation = await client.query(
        'INSERT INTO price_observations(observation_id, source_type, spec_id, supplier_id, trade_id, quote_id, price, quantity, currency, price_unit, quantity_unit, fulfilled_at, evidence_status, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14::jsonb) ON CONFLICT (observation_id) DO NOTHING RETURNING *',
        [observationId, sourceType, specId, input.supplierId || null, tradeId, input.quoteId || null, price, quantity, tradeTerms.currency, tradeTerms.priceUnit, tradeTerms.quantityUnit, input.fulfilledAt || null, input.evidenceStatus || 'VALID', JSON.stringify({ ...input.provenance, ...tradeTerms })],
      );
      await client.query(
        'INSERT INTO trade_events(trade_id, actor_kind, actor_ref, event_type, after_state, correlation_id) VALUES ($1::uuid, $2::actor_kind, $3, $4, $5::jsonb, $6)',
        [tradeId, audit.actorKind, audit.actorRef, 'COMPLETED_TRADE_PRICE_RECORDED', JSON.stringify({ observationId, inserted: observation.rows.length > 0, sourceType, specId, price, quantity }), audit.correlationId],
      );
      return { observation: observation.rows[0] || { observation_id: observationId, trade_id: tradeId }, idempotent: observation.rows.length === 0, correlationId: audit.correlationId };
    });
  }
}

export { mapEvidence, mapLot, mapOrder, mapTrade };

