import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPersistenceStore } from './persistence-store.mjs';

if (!process.env.DATABASE_URL) {
  console.log('postgres concurrent reservation tests: SKIP (DATABASE_URL not provided)');
  process.exit(0);
}

const store = await createPersistenceStore({ mode: 'postgresql', databaseUrl: process.env.DATABASE_URL });
const client = await store.pool.connect();
const buyerOrganizationId = randomUUID();
const supplierOrganizationId = randomUUID();
const buyerUserId = randomUUID();
const supplierUserId = randomUUID();
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const materialId = `TEST-CONCURRENCY-${suffix}`;
const specId = `TEST-CONCURRENCY-SPEC-${suffix}`;
const lotId = `TEST-CONCURRENCY-LOT-${suffix}`;
const testSpecAttributes = { purity: '99%' };
const orderIds = [];
let successfulReservation;

try {
  await client.query('BEGIN');
  await client.query('INSERT INTO organizations(organization_id, legal_name) VALUES ($1::uuid, $2), ($3::uuid, $4)', [buyerOrganizationId, `Concurrent Buyer ${suffix}`, supplierOrganizationId, `Concurrent Supplier ${suffix}`]);
  await client.query('INSERT INTO organization_members(organization_id, user_id, role) VALUES ($1::uuid, $2::uuid, \'BUYER\'::organization_member_role), ($3::uuid, $4::uuid, \'SUPPLIER\'::organization_member_role)', [buyerOrganizationId, buyerUserId, supplierOrganizationId, supplierUserId]);
  await client.query('INSERT INTO materials(material_id, canonical_name, status) VALUES ($1, $2, \'APPROVED\')', [materialId, `Concurrent test material ${suffix}`]);
  await client.query('INSERT INTO specifications(spec_id, material_id, status, attributes) VALUES ($1, $2, \'APPROVED\', $3::jsonb)', [specId, materialId, JSON.stringify(testSpecAttributes)]);
  await client.query('INSERT INTO lots(lot_id, supplier_organization_id, spec_id, state, total_quantity, available_quantity, ask_price, delivery_days) VALUES ($1, $2::uuid, $3, \'VERIFIED_ELIGIBLE\', 100, 100, 21800, 10)', [lotId, supplierOrganizationId, specId]);
  for (const evidenceType of ['COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF']) {
    await client.query('INSERT INTO evidences(lot_id, evidence_type, document_version, content_sha256, storage_ref, expires_at, state) VALUES ($1, $2, $3, $4, $5, $6::date, \'VALID\'::evidence_state)', [lotId, evidenceType, '1.0', 'b'.repeat(64), `integration/${lotId}/${evidenceType}`, '2027-01-01']);
  }
  await client.query('COMMIT');

  const adapter = store.domainAdapter;
  const makeOrder = (index) => adapter.submitOrder({ buyerOrganizationId, userId: buyerUserId, specId, specAttributes: testSpecAttributes, bidPrice: 21800, requestedQuantity: 100, deliveryDeadline: '2026-10-01', actorKind: 'HUMAN', actorRef: buyerUserId, correlationId: `CORR-CONCURRENT-SUBMIT-${suffix}-${index}` });
  const submitted = await Promise.all([makeOrder(1), makeOrder(2)]);
  orderIds.push(...submitted.map(({ order }) => order.order_id));

  const results = await Promise.allSettled(orderIds.map((orderId, index) => adapter.reserveInventory({ orderId, lotId, quantity: 100, idempotencyKey: `IDEMP-CONCURRENT-${suffix}-${index}`, actorKind: 'SYSTEM', actorRef: 'AI-08', correlationId: `CORR-CONCURRENT-RESERVE-${suffix}-${index}` })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  successfulReservation = results.find((result) => result.status === 'fulfilled')?.value.reservation.reservation_id;
  const lot = await store.pool.query('SELECT available_quantity, reserved_quantity FROM lots WHERE lot_id = $1', [lotId]);
  assert.equal(Number(lot.rows[0].available_quantity), 0);
  assert.equal(Number(lot.rows[0].reserved_quantity), 100);
  console.log('postgres concurrent reservation tests: PASS');
} finally {
  try { await client.query('BEGIN'); } catch {}
  try {
    for (const orderId of orderIds) {
      await client.query('DELETE FROM trade_events WHERE order_id = $1::uuid', [orderId]);
      await client.query('DELETE FROM reservations WHERE order_id = $1::uuid', [orderId]);
      await client.query('DELETE FROM purchase_orders WHERE order_id = $1::uuid', [orderId]);
    }
    await client.query('DELETE FROM trade_events WHERE lot_id = $1', [lotId]);
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
