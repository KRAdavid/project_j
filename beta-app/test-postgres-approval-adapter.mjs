import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const approval = {
  approval_id: 'APPROVAL-PG-001',
  task_id: 'TASK-PG-001',
  source_run_id: 'RUN-PG-001',
  required_principal: 'H-01',
  objective: 'PostgreSQL 승인 원장 검증',
  risk: 'critical',
  reviewers: ['AI-11 실드'],
  state: 'PENDING',
  decision: null,
  decision_note: null,
  decided_by: null,
  created_at: '2026-09-08T00:00:00.000Z',
  decided_at: null,
};
const queries = [];
const client = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('SELECT * FROM operational_approvals')) return { rows: [{ ...approval }] };
    if (sql.includes('UPDATE operational_approvals')) {
      Object.assign(approval, { state: params[0], decision: params[1], decision_note: params[2], decided_by: params[3], decided_at: '2026-09-08T00:01:00.000Z' });
      return { rows: [{ ...approval }] };
    }
    if (sql.includes('INSERT INTO approval_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  },
  release() {},
};
const pool = {
  async connect() { return client; },
  async query(sql) {
    if (sql.includes('SELECT * FROM operational_approvals ORDER BY')) return { rows: [{ ...approval }] };
    throw new Error(`unexpected pool query: ${sql}`);
  },
};

const adapter = new PostgresDomainAdapter(pool);
assert.equal((await adapter.listOperationalApprovals())[0].status, 'PENDING');
const decided = await adapter.decideOperationalApproval({ approvalId: approval.approval_id, decision: 'hold', decidedBy: '00000000-0000-0000-0000-000000000001', actorKind: 'HUMAN', correlationId: 'CORR-PG-001', note: '추가 증거 확인' });
assert.equal(decided.item.status, 'HELD');
assert.equal(decided.idempotent, false);
const idempotent = await adapter.decideOperationalApproval({ approvalId: approval.approval_id, decision: 'hold', decidedBy: '00000000-0000-0000-0000-000000000001', actorKind: 'HUMAN', correlationId: 'CORR-PG-002' });
assert.equal(idempotent.idempotent, true);
await assert.rejects(() => adapter.decideOperationalApproval({ approvalId: approval.approval_id, decision: 'approve', decidedBy: '00000000-0000-0000-0000-000000000001', actorKind: 'HUMAN', correlationId: 'CORR-PG-003' }), (error) => error instanceof PostgresDomainAdapterError && error.code === 'APPROVAL_ALREADY_DECIDED');
assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO approval_events')).length, 1);
console.log('postgres approval adapter tests: PASS');
