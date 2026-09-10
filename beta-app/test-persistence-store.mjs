import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersistenceStore, PersistenceStoreError, PostgresSnapshotStore } from './persistence-store.mjs';
import { assertProductionCutover } from './persistence-mode.mjs';
import { GABA_SPEC_ATTRIBUTES, GABA_SPEC_ID, TradeEngine } from './trade-engine.mjs';

const snapshot = { dataStatus: 'SIMULATED_BACKEND', orders: [{ orderId: 'ORDER-001' }], trades: [] };
const priceObservation = { tradeId: 'T-PRICE-001', sourceType: 'COMPLETED_PHYSICAL_TRADE', specId: GABA_SPEC_ID, supplierId: 'S-PRICE-001', price: 21800, quantity: 200, fulfilledAt: '2026-09-08', status: 'FULFILLED', evidenceStatus: 'VALID' };
const productionConfig = { databaseUrl: 'postgres://redacted', schemaApplied: true, backupDrillPassed: true, isolationVerified: true, auditPolicyApplied: true, objectStorageReady: true, evidenceStoreReady: true, authProviderReady: true, authJwtSecret: 'test-secret-that-is-at-least-32-bytes-long', authJwtIssuer: 'raw-material-os-test', authJwtAudience: 'raw-material-os-api', postgresDomainAdapterReady: true, postgresDomainApiReady: true, postgresDomainReconciliationVerified: true };
assert.equal(assertProductionCutover(productionConfig).ready, true);
assert.equal(assertProductionCutover({ ...productionConfig, authJwtSecret: 'too-short' }).ready, false);
assert.equal(assertProductionCutover({ ...productionConfig, authJwtSecret: undefined }).ready, false);
assert.equal(assertProductionCutover({ ...productionConfig, authJwtIssuer: undefined }).ready, false);
assert.equal(assertProductionCutover({ ...productionConfig, postgresDomainAdapterReady: false }).ready, false);
assert.equal(assertProductionCutover({ ...productionConfig, postgresDomainApiReady: false }).ready, false);
assert.equal(assertProductionCutover({ ...productionConfig, postgresDomainReconciliationVerified: false }).ready, false);
const memory = await createPersistenceStore({ mode: 'memory' });
await memory.save(snapshot);
assert.deepEqual(await memory.load(), snapshot);
await memory.saveEvidence({ records: [{ evidenceId: 'E-001' }], events: [] });
assert.deepEqual(await memory.loadEvidence(), { records: [{ evidenceId: 'E-001' }], events: [] });
await memory.savePriceObservations([priceObservation]);
assert.deepEqual(await memory.loadPriceObservations(), [priceObservation]);
await memory.close();

await assert.rejects(
  () => createPersistenceStore({ mode: 'postgresql', databaseUrl: '' }),
  (error) => error instanceof PersistenceStoreError && error.code === 'POSTGRES_DATABASE_URL_REQUIRED',
);

const fakeQueries = [];
const fakeClient = {
  async query(sql, params) {
    fakeQueries.push({ sql, params });
    if (sql.startsWith('SELECT payload')) return { rows: [] };
    return { rows: [] };
  },
  release() {},
};
const fakePool = {
  async connect() { return fakeClient; },
  async query() { return { rows: [] }; },
  async end() {},
};
const atomicStore = new PostgresSnapshotStore(fakePool);
const schemaTables = ['organizations', 'organization_members', 'materials', 'material_aliases', 'specifications', 'lots', 'evidences', 'offers', 'purchase_orders', 'reservations', 'trades', 'trade_inspections', 'trade_events', 'operational_approvals', 'approval_events', 'ledger_snapshots', 'evidence_snapshots', 'price_observations'];
const schemaPool = {
  async query(sql) {
    if (sql.includes('information_schema.tables')) return { rows: schemaTables.map((table_name) => ({ table_name })) };
    if (sql.includes('to_regprocedure')) return { rows: [{ function_name: 'reserve_lot(uuid,text,numeric,text)' }] };
    return { rows: [] };
  },
};
const schemaStore = new PostgresSnapshotStore(schemaPool);
assert.deepEqual((await schemaStore.verifySchema()).tables, schemaTables);
await assert.rejects(() => new PostgresSnapshotStore({ async query(sql) { if (sql.includes('information_schema.tables')) return { rows: [] }; return { rows: [] }; } }).verifySchema(), (error) => error.code === 'POSTGRES_SCHEMA_INCOMPLETE');
const membershipStore = new PostgresSnapshotStore({ async query(sql, params) { if (sql.includes('organization_members')) return { rows: params[1] === 'USER-001' ? [{ '?column?': 1 }] : [] }; return { rows: [] }; } });
assert.equal(await membershipStore.isOrganizationMember({ userId: 'USER-001', organizationId: 'ORG-001', role: 'BUYER' }), true);
assert.equal(await membershipStore.isOrganizationMember({ userId: 'USER-002', organizationId: 'ORG-001', role: 'BUYER' }), false);
const atomicEngine = new TradeEngine();
const atomicResult = await atomicStore.runAtomic(atomicEngine, () => atomicEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 100, deliveryDays: 14 }));
assert.equal(atomicResult.result.order.orderId, 'ORDER-00001');
assert.ok(fakeQueries.some(({ sql }) => sql.includes('pg_advisory_xact_lock')));
assert.ok(fakeQueries.some(({ sql }) => sql === 'COMMIT'));

const rollbackQueries = [];
const rollbackClient = {
  async query(sql, params) {
    rollbackQueries.push({ sql, params });
    if (sql.startsWith('INSERT INTO ledger_snapshots')) throw new Error('simulated write failure');
    return { rows: [] };
  },
  release() {},
};
const rollbackStore = new PostgresSnapshotStore({ async connect() { return rollbackClient; }, async query() { return { rows: [] }; }, async end() {} });
const rollbackEngine = new TradeEngine();
const rollbackBefore = rollbackEngine.snapshot();
await assert.rejects(() => rollbackStore.runAtomic(rollbackEngine, () => rollbackEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 100, deliveryDays: 14 })), /simulated write failure/);
assert.deepEqual(rollbackEngine.snapshot(), rollbackBefore);
assert.ok(rollbackQueries.some(({ sql }) => sql === 'ROLLBACK'));

const filePath = join(tmpdir(), `raw-material-ledger-${Date.now()}.sqlite`);
const sqlite = await createPersistenceStore({ mode: 'sqlite', filePath });
await sqlite.save(snapshot);
assert.deepEqual(await sqlite.load(), snapshot);
await sqlite.saveEvidence({ records: [{ evidenceId: 'E-002' }], events: [] });
assert.deepEqual(await sqlite.loadEvidence(), { records: [{ evidenceId: 'E-002' }], events: [] });
await sqlite.savePriceObservations([priceObservation]);
assert.deepEqual(await sqlite.loadPriceObservations(), [priceObservation]);
await sqlite.close();
await rm(filePath, { force: true });

const recoveryPath = join(tmpdir(), `raw-material-recovery-${Date.now()}.sqlite`);
const firstStore = await createPersistenceStore({ mode: 'sqlite', filePath: recoveryPath });
const firstEngine = new TradeEngine();
const order = firstEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14 });
firstEngine.acceptOrder(order.order.orderId, { lotId: 'GBA-KR-2407' });
await firstStore.save(firstEngine.snapshot());
await firstStore.close();

const secondStore = await createPersistenceStore({ mode: 'sqlite', filePath: recoveryPath });
const secondEngine = new TradeEngine(await secondStore.load());
assert.equal(secondEngine.snapshot().orders[0].status, 'TRADE_CONFIRMED');
assert.equal(secondEngine.snapshot().lots[0].availableQty, 1000);
const nextOrder = secondEngine.submitOrder({ specId: GABA_SPEC_ID, specAttributes: GABA_SPEC_ATTRIBUTES, price: 21800, quantity: 200, deliveryDays: 14 });
assert.equal(nextOrder.order.orderId, 'ORDER-00002');
await secondStore.close();
await rm(recoveryPath, { force: true });

console.log('persistence store tests: PASS');

