import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPersistenceStore } from './persistence-store.mjs';
import { PostgresDomainAdapter } from './postgres-domain-adapter.mjs';

if (!process.env.DATABASE_URL) {
  console.log('postgres integration tests: SKIP (DATABASE_URL not provided)');
  process.exit(0);
}

const store = await createPersistenceStore({ mode: 'postgresql', databaseUrl: process.env.DATABASE_URL });
const client = await store.pool.connect();
const adapter = store.domainAdapter || new PostgresDomainAdapter(store.pool);
const buyerOrganizationId = randomUUID();
const supplierOrganizationId = randomUUID();
const buyerUserId = randomUUID();
const supplierUserId = randomUUID();
const operatorUserId = randomUUID();
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const materialId = `TEST-GABA-${suffix}`;
const specId = `TEST-GABA-SPEC-${suffix}`;
const lotId = `TEST-GABA-LOT-${suffix}`;
const testSpecAttributes = { purity: '99%' };
let orderId;
let tradeId;

try {
  await client.query('BEGIN');
  await client.query('INSERT INTO organizations(organization_id, legal_name) VALUES ($1::uuid, $2), ($3::uuid, $4)', [buyerOrganizationId, `Buyer ${suffix}`, supplierOrganizationId, `Supplier ${suffix}`]);
  await client.query('INSERT INTO organization_members(organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, \'BUYER\'::organization_member_role), ($3::uuid, $4::uuid, \'SUPPLIER\'::organization_member_role), ($1::uuid, $5::uuid, \'OPERATOR\'::organization_member_role)', [buyerOrganizationId, buyerUserId, supplierOrganizationId, supplierUserId, operatorUserId]);
  await client.query('INSERT INTO materials(material_id, canonical_name, status) VALUES ($1, $2, \'APPROVED\')', [materialId, `Test GABA ${suffix}`]);
  await client.query('INSERT INTO specifications(spec_id, material_id, status, attributes) VALUES ($1, $2, \'APPROVED\', $3::jsonb)', [specId, materialId, JSON.stringify(testSpecAttributes)]);
  await client.query('INSERT INTO lots(lot_id, supplier_organization_id, spec_id, state, total_quantity, available_quantity, ask_price, delivery_days) VALUES ($1, $2::uuid, $3, \'VERIFIED_ELIGIBLE\', 1000, 1000, 21800, 10)', [lotId, supplierOrganizationId, specId]);
  for (const evidenceType of ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF']) {
    await client.query('INSERT INTO evidences(lot_id, evidence_type, document_version, content_sha256, storage_ref, expires_at, state) VALUES ($1, $2, $3, $4, $5, $6::date, \'VALID\'::evidence_state)', [lotId, evidenceType, '1.0', 'a'.repeat(64), `integration/${lotId}/${evidenceType}`, '2027-01-01']);
  }
  await client.query('COMMIT');

  const submitted = await adapter.submitOrder({ buyerOrganizationId, userId: buyerUserId, specId, specAttributes: testSpecAttributes, bidPrice: 21800, requestedQuantity: 100, deliveryDeadline: '2026-10-01', actorKind: 'HUMAN', actorRef: buyerUserId, correlationId: `CORR-SUBMIT-${suffix}` });
  orderId = submitted.order.order_id;
  const reserved = await adapter.reserveInventory({ orderId, lotId, quantity: 100, idempotencyKey: `IDEMP-${suffix}`, actorKind: 'SYSTEM', actorRef: 'AI-08', correlationId: `CORR-RESERVE-${suffix}` });
  assert.equal(Number(reserved.reservation.quantity), 100);
  const confirmed = await adapter.confirmTrade({ orderId, supplierOrganizationId, buyerOrganizationId, supplierUserId, buyerUserId, lotId, price: 21800, quantity: 100, deliveryDeadline: '2026-10-01', specSnapshot: { specId, attributes: testSpecAttributes }, lotSnapshot: { lotId, quantity: 100 }, evidenceSnapshot: { coa: 'VALID', sds: 'VALID', tds: 'VALID', lotTrace: 'VALID', inventoryProof: 'VALID' }, pretradeChecks: { specMatch: true, evidenceValid: true, lotTraceable: true, inventoryAvailable: true }, tradeSnapshotHash: 'a'.repeat(64), actorKind: 'SYSTEM', actorRef: 'AI-02', correlationId: `CORR-CONFIRM-${suffix}` });
  tradeId = confirmed.trade.trade_id;
  await adapter.markDelivered({ tradeId, supplierOrganizationId, supplierUserId, actorKind: 'HUMAN', actorRef: supplierUserId, correlationId: `CORR-DELIVER-${suffix}` });
  const inspected = await adapter.inspectTrade({ tradeId, operatorOrganizationId: buyerOrganizationId, operatorUserId, specMatch: true, qualityPass: true, note: 'integration test inspection', actorKind: 'HUMAN', actorRef: operatorUserId, correlationId: `CORR-INSPECT-${suffix}` });
  assert.equal(inspected.inspection.state, 'COMPLETED');
  const observed = await adapter.recordCompletedTradePrice({ tradeId, specId, price: 21800, quantity: 100, fulfilledAt: '2026-09-09', deliveryAndInspectionComplete: true, provenance: { source: 'integration-test', materialId, evidenceStatus: 'VALID' }, actorKind: 'SYSTEM', actorRef: 'AI-05', correlationId: `CORR-PRICE-${suffix}` });
  assert.equal(observed.observation.trade_id, tradeId);
  const lot = await store.pool.query('SELECT available_quantity, reserved_quantity FROM lots WHERE lot_id = $1', [lotId]);
  assert.equal(Number(lot.rows[0].available_quantity), 900);
  assert.equal(Number(lot.rows[0].reserved_quantity), 100);
  console.log('postgres integration tests: PASS');
} finally {
  try { await client.query('BEGIN'); } catch {}
  try {
    if (tradeId) await client.query('DELETE FROM trade_events WHERE trade_id = $1::uuid', [tradeId]);
    if (tradeId) await client.query('DELETE FROM trade_inspections WHERE trade_id = $1::uuid', [tradeId]);
    if (tradeId) await client.query('DELETE FROM price_observations WHERE trade_id = $1', [tradeId]);
    if (tradeId) await client.query('DELETE FROM trades WHERE trade_id = $1::uuid', [tradeId]);
    if (orderId) await client.query('DELETE FROM reservations WHERE order_id = $1::uuid', [orderId]);
    if (orderId) await client.query('DELETE FROM trade_events WHERE order_id = $1::uuid', [orderId]);
    if (orderId) await client.query('DELETE FROM purchase_orders WHERE order_id = $1::uuid', [orderId]);
    await client.query('DELETE FROM evidences WHERE lot_id = $1', [lotId]);
    await client.query('DELETE FROM lots WHERE lot_id = $1', [lotId]);
    await client.query('DELETE FROM specifications WHERE spec_id = $1', [specId]);
    await client.query('DELETE FROM materials WHERE material_id = $1', [materialId]);
    await client.query('DELETE FROM organization_members WHERE organization_id IN ($1::uuid, $2::uuid)', [buyerOrganizationId, supplierOrganizationId]);
    await client.query('DELETE FROM organizations WHERE organization_id IN ($1::uuid, $2::uuid)', [buyerOrganizationId, supplierOrganizationId]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await store.close();
  }
}

