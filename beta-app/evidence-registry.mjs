import { randomUUID } from 'node:crypto';
import { hashDocument, loadEvidencePolicy, verifyEvidenceBundle } from './evidence-verifier.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const policy = loadEvidencePolicy();

export class EvidenceRegistryError extends Error {
  constructor(message, code = 'EVIDENCE_REGISTRY_FAILED') {
    super(message);
    this.code = code;
  }
}

export class EvidenceRegistry {
  constructor({ now = () => new Date(), snapshot = null } = {}) {
    this.now = now;
    this.records = new Map();
    this.events = [];
    if (snapshot) this.restore(snapshot);
  }

  recordEvent(type, details) {
    this.events.unshift({ eventId: `EVIDENCE-EVENT-${randomUUID().slice(0, 8).toUpperCase()}`, type, details, occurredAt: this.now().toISOString() });
    this.events = this.events.slice(0, 100);
  }

  submit(input = {}) {
    const lotId = String(input.lotId || '');
    const evidenceType = String(input.evidenceType || '');
    const documentVersion = String(input.documentVersion || '');
    const submittedBy = String(input.submittedBy || '');
    if (!lotId || !documentVersion || !submittedBy) throw new EvidenceRegistryError('로트·문서 버전·제출자가 필요합니다.', 'EVIDENCE_METADATA_REQUIRED');
    if (!policy.requiredTypes.includes(evidenceType)) throw new EvidenceRegistryError('허용되지 않은 증빙 유형입니다.', 'EVIDENCE_TYPE_NOT_ALLOWED');
    const duplicate = [...this.records.values()].find((record) => record.lotId === lotId && record.evidenceType === evidenceType && record.documentVersion === documentVersion && record.state !== 'SUPERSEDED');
    if (duplicate) throw new EvidenceRegistryError('동일 로트·증빙 유형·버전이 이미 제출되었습니다.', 'EVIDENCE_ALREADY_SUBMITTED');
    const content = input.content === undefined ? '' : String(input.content);
    const contentSha256 = String(input.contentSha256 || (content ? hashDocument(content) : ''));
    const record = {
      evidenceId: `EVIDENCE-${randomUUID().slice(0, 8).toUpperCase()}`,
      lotId,
      evidenceType,
      documentVersion,
      contentSha256,
      storageRef: String(input.storageRef || `sim://evidence/${lotId}/${evidenceType}/${documentVersion}`),
      organizationId: String(input.organizationId || ''),
      issuedAt: input.issuedAt ? String(input.issuedAt) : null,
      expiresAt: input.expiresAt ? String(input.expiresAt) : null,
      state: 'PENDING',
      submittedBy,
      submittedAt: this.now().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };
    this.records.set(record.evidenceId, record);
    this.recordEvent('EVIDENCE_SUBMITTED', { evidenceId: record.evidenceId, lotId, evidenceType });
    return clone(record);
  }

  review(evidenceId, { decision, reviewerRole, reviewerId } = {}) {
    const record = this.records.get(String(evidenceId));
    if (!record) throw new EvidenceRegistryError('증빙을 찾을 수 없습니다.', 'EVIDENCE_NOT_FOUND');
    if (!['OWNER', 'OPERATOR'].includes(String(reviewerRole))) throw new EvidenceRegistryError('AI 또는 일반 사용자는 증빙을 승인할 수 없습니다.', 'HUMAN_REVIEW_REQUIRED');
    if (!reviewerId) throw new EvidenceRegistryError('검토자 ID가 필요합니다.', 'REVIEWER_REQUIRED');
    if (!['VALID', 'REJECTED'].includes(String(decision))) throw new EvidenceRegistryError('검토 결정은 VALID 또는 REJECTED여야 합니다.', 'INVALID_REVIEW_DECISION');
    record.state = decision;
    record.reviewedBy = String(reviewerId);
    record.reviewedAt = this.now().toISOString();
    this.recordEvent('EVIDENCE_REVIEWED', { evidenceId: record.evidenceId, decision, reviewerId: record.reviewedBy });
    return clone(record);
  }

  list(lotId) {
    return [...this.records.values()].filter((record) => !lotId || record.lotId === String(lotId)).map(clone);
  }

  get(evidenceId) {
    const record = this.records.get(String(evidenceId));
    if (!record) throw new EvidenceRegistryError('증빙을 찾을 수 없습니다.', 'EVIDENCE_NOT_FOUND');
    return clone(record);
  }

  eligibility(lotId) {
    return verifyEvidenceBundle({ lotId: String(lotId || ''), evidence: this.list(lotId), now: this.now() });
  }

  snapshot() {
    return { records: this.list(), events: clone(this.events) };
  }

  restore(snapshot = {}) {
    this.records = new Map((snapshot.records || []).map((record) => [record.evidenceId, clone(record)]));
    this.events = clone(snapshot.events || []);
  }
}
