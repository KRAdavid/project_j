import assert from 'node:assert/strict';
import { PostgresDomainAdapter, PostgresDomainAdapterError } from './postgres-domain-adapter.mjs';

const ids = {
  org: '00000000-0000-0000-0000-000000000041',
  user: '00000000-0000-0000-0000-000000000042',
  trade: '00000000-0000-0000-0000-000000000043',
  order: '00000000-0000-0000-0000-000000000044',
  reservation: '00000000-0000-0000-0000-000000000045',
};

const terminalTrade = (state) => ({
  trade_id: ids.trade,
  order_id: ids.order,
  lot_id: 'LOT-IDEMP',
  state,
  supplier_organization_id: ids.org,
  price: '21800',
  quantity: '100',
  spec_id: 'GABA-SPEC-001',
  reservation_id: ids.reservation,
  reservation_state: state === 'COMPLETED' ? 'CONSUMED' : 'ACTIVE',
  currency: 'KRW',
  price_unit: 'KRW_PER_KG',
  quantity_unit: 'KG',
});

const makeClient = ({ state, inspection, observation = null }) => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM organization_members')) return { rows: [{ ok: 1 }] };
      if (sql.includes('FROM trades t JOIN')) return { rows: [terminalTrade(state)] };
      if (sql.includes('FROM trade_inspections')) return { rows: inspection ? [inspection] : [] };
      if (sql.includes('FROM price_observations')) return { rows: observation ? [observation] : [] };
      if (sql.includes('UPDATE trades SET state')) throw new Error('terminal retry must not update trades');
      if (sql.includes('INSERT INTO trade_inspections')) throw new Error('terminal retry must not insert inspection');
      if (sql.includes('INSERT INTO price_observations')) throw new Error('terminal retry must not insert price observation');
      return { rows: [] };
    },
    release() {},
  };
  return { client, calls };
};

const deliveredClient = makeClient({ state: 'DELIVERED' });
const deliveredAdapter = new PostgresDomainAdapter({ async connect() { return deliveredClient.client; } });
const delivered = await deliveredAdapter.markDelivered({
  tradeId: ids.trade,
  supplierOrganizationId: ids.org,
  supplierUserId: ids.user,
  actorRef: ids.user,
  correlationId: 'DELIVER-RETRY-001',
});
assert.equal(delivered.idempotent, true);
assert.equal(delivered.trade.state, 'DELIVERED');
assert.equal(deliveredClient.calls.some(({ sql }) => sql.includes('UPDATE trades SET state')), false);

const inspection = { trade_id: ids.trade, reservation_id: ids.reservation, state: 'COMPLETED', spec_match: true, quality_pass: true };
const inspectClient = makeClient({ state: 'COMPLETED', inspection });
const inspectAdapter = new PostgresDomainAdapter({ async connect() { return inspectClient.client; } });
const inspected = await inspectAdapter.inspectTrade({
  tradeId: ids.trade,
  operatorOrganizationId: ids.org,
  operatorUserId: ids.user,
  specMatch: true,
  qualityPass: true,
  actorRef: ids.user,
  correlationId: 'INSPECT-RETRY-001',
});
assert.equal(inspected.idempotent, true);
assert.equal(inspected.inspection.trade_id, ids.trade);
await assert.rejects(
  () => inspectAdapter.inspectTrade({
    tradeId: ids.trade,
    operatorOrganizationId: ids.org,
    operatorUserId: ids.user,
    specMatch: false,
    qualityPass: true,
    actorRef: ids.user,
    correlationId: 'INSPECT-RETRY-MISMATCH',
  }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'INSPECTION_RETRY_MISMATCH',
);

const pricedClient = makeClient({
  state: 'COMPLETED',
  inspection,
  observation: { observation_id: ids.trade, trade_id: ids.trade, price: '21800', quantity: '100' },
});
const pricedAdapter = new PostgresDomainAdapter({ async connect() { return pricedClient.client; } });
const priced = await pricedAdapter.inspectTradeAndRecordPrice({
  tradeId: ids.trade,
  operatorOrganizationId: ids.org,
  operatorUserId: ids.user,
  specMatch: true,
  qualityPass: true,
  actorRef: ids.user,
  observationId: ids.trade,
  correlationId: 'INSPECT-PRICE-RETRY-001',
});
assert.equal(priced.idempotent, true);
assert.equal(priced.priceObservationIdempotent, true);
assert.equal(priced.observation.observation_id, ids.trade);
assert.equal(pricedClient.calls.some(({ sql }) => sql.includes('INSERT INTO trade_inspections')), false);
assert.equal(pricedClient.calls.some(({ sql }) => sql.includes('INSERT INTO price_observations')), false);
await assert.rejects(
  () => pricedAdapter.inspectTradeAndRecordPrice({
    tradeId: ids.trade,
    operatorOrganizationId: ids.org,
    operatorUserId: ids.user,
    specMatch: true,
    qualityPass: true,
    price: 21900,
    actorRef: ids.user,
    observationId: ids.trade,
    correlationId: 'INSPECT-PRICE-RETRY-MISMATCH',
  }),
  (error) => error instanceof PostgresDomainAdapterError && error.code === 'PRICE_TRADE_VALUE_MISMATCH',
);

console.log('postgres command idempotency tests: PASS');
