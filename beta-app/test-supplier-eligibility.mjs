import assert from 'node:assert/strict';
import { PostgresDomainAdapter } from './postgres-domain-adapter.mjs';

const organizationId = '00000000-0000-0000-0000-000000000081';
const row = {
  organization_id: organizationId,
  legal_name: '검증 공급기업',
  verified_at: '2026-09-08T00:00:00.000Z',
  has_verification_evidence: true,
  active_supplier_membership: true,
};
const pool = {
  async connect() { throw new Error('eligibility contract test must use the read-only pool query path'); },
  async query(sql, params = []) {
    if (sql.includes('supplier_verification_requests')) return { rows: [] };
    assert.match(sql, /FROM organizations o/);
    assert.deepEqual(params, [organizationId]);
    return { rows: [row] };
  },
};

const eligibility = await new PostgresDomainAdapter(pool).supplierEligibility(organizationId);
assert.equal(eligibility.organizationVerified, true);
assert.equal(eligibility.activeSupplierMembership, true);
assert.equal(eligibility.eligibleToSubmitLot, true);
assert.deepEqual(eligibility.reasons, []);
assert.deepEqual(eligibility.policy.requiredLotEvidence, ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF']);
console.log('supplier eligibility contract tests: PASS');

const requestId = '00000000-0000-0000-0000-000000000082';
const requestUserId = '00000000-0000-0000-0000-000000000083';
const requestRow = {
  request_id: requestId,
  organization_id: organizationId,
  requested_by: requestUserId,
  business_registration_ref: 'vault://business-registration/001',
  evidence_refs: { businessRegistration: 'vault://business-registration/001', supplierIdentity: 'vault://supplier-identity/001' },
  state: 'REQUESTED',
  decision_note: null,
  decided_by: null,
  requested_at: '2026-09-08T00:00:00.000Z',
  decided_at: null,
};
const openRequestRow = {
  ...requestRow,
  legal_name: '검증 대기 공급기업',
  approval_state: 'PENDING',
};
const listPool = {
  async connect() { throw new Error('supplier verification list contract test must use the read-only pool query path'); },
  async query(sql) {
    assert.match(sql, /FROM supplier_verification_requests r/);
    assert.match(sql, /operational_approvals/);
    return { rows: [openRequestRow] };
  },
};
const openRequests = await new PostgresDomainAdapter(listPool).listSupplierVerificationRequests();
assert.equal(openRequests.length, 1);
assert.equal(openRequests[0].organizationName, '검증 대기 공급기업');
assert.equal(openRequests[0].approvalStatus, 'PENDING');
assert.equal(openRequests[0].status, 'REQUESTED');
console.log('supplier verification operator queue contract: PASS');

const requestClient = {
  async query(sql) {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM organizations WHERE')) return { rows: [{ organization_id: organizationId, verified_at: null, verification_evidence: {} }] };
    if (sql.includes('FROM supplier_verification_requests')) return { rows: [] };
    if (sql.includes('INSERT INTO supplier_verification_requests')) return { rows: [requestRow] };
    if (sql.includes('INSERT INTO operational_approvals')) return { rows: [] };
    if (sql.includes('INSERT INTO trade_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  },
  release() {},
};
const requested = await new PostgresDomainAdapter({ async connect() { return requestClient; } }).requestSupplierVerification({
  supplierOrganizationId: organizationId,
  supplierUserId: requestUserId,
  businessRegistrationRef: requestRow.business_registration_ref,
  evidenceRefs: requestRow.evidence_refs,
  actorKind: 'HUMAN',
  actorRef: requestUserId,
  correlationId: 'SUPPLIER-VERIFY-CONTRACT-001',
});
assert.equal(requested.status, 'REQUESTED');
assert.equal(requested.idempotent, false);
assert.equal(requested.request.requestId, requestId);
console.log('supplier verification request contract: PASS');

const reviewedRequest = { ...requestRow, approval_id: `SUPPLIER-VERIFY-${organizationId}` };
const reviewClient = {
  async query(sql) {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM supplier_verification_requests r JOIN organizations')) return { rows: [reviewedRequest] };
    if (sql.includes('FROM operational_approvals')) return { rows: [{ state: 'APPROVED' }] };
    if (sql.includes('UPDATE organizations')) return { rows: [] };
    if (sql.includes('UPDATE supplier_verification_requests')) return { rows: [{ ...reviewedRequest, state: 'APPROVED', decided_by: requestUserId, decided_at: '2026-09-08T00:02:00.000Z' }] };
    if (sql.includes('INSERT INTO trade_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  },
  release() {},
};
const reviewed = await new PostgresDomainAdapter({ async connect() { return reviewClient; } }).reviewSupplierVerification({
  requestId,
  reviewerOrganizationId: organizationId,
  reviewerUserId: requestUserId,
  decision: 'APPROVED',
  actorKind: 'HUMAN',
  actorRef: requestUserId,
  correlationId: 'SUPPLIER-VERIFY-REVIEW-001',
});
assert.equal(reviewed.status, 'APPROVED');
assert.equal(reviewed.idempotent, false);
assert.equal(reviewed.request.status, 'APPROVED');
console.log('supplier verification final review contract: PASS');
