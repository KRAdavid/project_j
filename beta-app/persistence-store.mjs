import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDomainAdapter } from './postgres-domain-adapter.mjs';

const defaultFilePath = resolve(fileURLToPath(new URL('../data/beta-ledger.sqlite', import.meta.url)));

export class PersistenceStoreError extends Error {
  constructor(message, code = 'PERSISTENCE_STORE_FAILED') {
    super(message);
    this.code = code;
  }
}

class MemoryStore {
  constructor() { this.mode = 'memory'; this.snapshot = null; this.evidenceSnapshot = null; this.priceObservations = []; }
  async load() { return this.snapshot; }
  async save(snapshot) { this.snapshot = JSON.parse(JSON.stringify(snapshot)); }
  async loadEvidence() { return this.evidenceSnapshot; }
  async saveEvidence(snapshot) { this.evidenceSnapshot = JSON.parse(JSON.stringify(snapshot)); }
  async loadPriceObservations() { return JSON.parse(JSON.stringify(this.priceObservations)); }
  async savePriceObservations(observations = []) { this.priceObservations.push(...JSON.parse(JSON.stringify(observations))); }
  async close() {}
}

class SqliteSnapshotStore {
  constructor(database, filePath) {
    this.mode = 'sqlite';
    this.database = database;
    this.filePath = filePath;
    this.database.exec('CREATE TABLE IF NOT EXISTS ledger_snapshots (snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
    this.database.exec('CREATE TABLE IF NOT EXISTS evidence_snapshots (snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
    this.database.exec('CREATE TABLE IF NOT EXISTS price_observations (observation_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
  }

  async load() {
    const row = this.database.prepare('SELECT payload FROM ledger_snapshots ORDER BY snapshot_id DESC LIMIT 1').get();
    return row ? JSON.parse(row.payload) : null;
  }

  async save(snapshot) {
    this.database.prepare('INSERT INTO ledger_snapshots(payload, created_at) VALUES (?, ?)').run(JSON.stringify(snapshot), new Date().toISOString());
  }

  async loadEvidence() {
    const row = this.database.prepare('SELECT payload FROM evidence_snapshots ORDER BY snapshot_id DESC LIMIT 1').get();
    return row ? JSON.parse(row.payload) : null;
  }

  async saveEvidence(snapshot) {
    this.database.prepare('INSERT INTO evidence_snapshots(payload, created_at) VALUES (?, ?)').run(JSON.stringify(snapshot), new Date().toISOString());
  }

  async loadPriceObservations() {
    return this.database.prepare('SELECT payload FROM price_observations ORDER BY created_at ASC').all().map((row) => JSON.parse(row.payload));
  }

  async savePriceObservations(observations = []) {
    const statement = this.database.prepare('INSERT OR IGNORE INTO price_observations(observation_id, payload, created_at) VALUES (?, ?, ?)');
    for (const observation of observations) statement.run(String(observation.tradeId || observation.quoteId || observation.sourceId), JSON.stringify(observation), new Date().toISOString());
  }

  async close() { this.database.close(); }
}

export class PostgresSnapshotStore {
  constructor(pool) {
    this.mode = 'postgresql';
    this.pool = pool;
    this.domainAdapter = typeof pool?.connect === 'function' ? new PostgresDomainAdapter(pool) : null;
  }

  async verifySchema() {
    const requiredTables = ['organizations', 'organization_members', 'materials', 'material_aliases', 'specifications', 'lots', 'evidences', 'offers', 'purchase_orders', 'reservations', 'trades', 'trade_inspections', 'trade_events', 'operational_approvals', 'approval_events', 'ledger_snapshots', 'evidence_snapshots', 'price_observations'];
    const tables = await this.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])", [requiredTables]);
    const present = new Set(tables.rows.map((row) => row.table_name));
    const missing = requiredTables.filter((table) => !present.has(table));
    if (missing.length) throw new PersistenceStoreError(`PostgreSQL 원장 스키마가 불완전합니다: ${missing.join(', ')}`, 'POSTGRES_SCHEMA_INCOMPLETE');
    const functionResult = await this.pool.query("SELECT to_regprocedure('public.reserve_lot(uuid,text,numeric,text)') AS function_name");
    if (!functionResult.rows[0]?.function_name) throw new PersistenceStoreError('PostgreSQL 원자 예약 함수가 없어 상용 원장을 시작할 수 없습니다.', 'POSTGRES_RESERVATION_FUNCTION_MISSING');
    return { tables: requiredTables, reservationFunction: functionResult.rows[0].function_name };
  }

  async isOrganizationMember({ userId, organizationId, role } = {}) {
    const result = await this.pool.query("SELECT 1 FROM organization_members WHERE organization_id::text = $1 AND user_id::text = $2 AND role = $3::organization_member_role AND active = true LIMIT 1", [String(organizationId || ''), String(userId || ''), String(role || '')]);
    return result.rows.length > 0;
  }

  async load() {
    const result = await this.pool.query('SELECT payload FROM ledger_snapshots ORDER BY snapshot_id DESC LIMIT 1');
    return result.rows[0]?.payload || null;
  }

  async loadEvidence() {
    const result = await this.pool.query('SELECT payload FROM evidence_snapshots ORDER BY snapshot_id DESC LIMIT 1');
    return result.rows[0]?.payload || null;
  }

  async save(snapshot) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO ledger_snapshots(payload) VALUES ($1::jsonb)', [JSON.stringify(snapshot)]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async saveEvidence(snapshot) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO evidence_snapshots(payload) VALUES ($1::jsonb)', [JSON.stringify(snapshot)]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async loadPriceObservations() {
    const result = await this.pool.query('SELECT payload FROM price_observations ORDER BY created_at ASC');
    return result.rows.map((row) => row.payload);
  }

  async savePriceObservations(observations = []) {
    if (!observations.length) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const observation of observations) {
        const identity = String(observation.tradeId || observation.quoteId || observation.sourceId);
        await client.query('INSERT INTO price_observations(observation_id, source_type, spec_id, supplier_id, trade_id, quote_id, price, quantity, currency, price_unit, quantity_unit, fulfilled_at, evidence_status, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb) ON CONFLICT (observation_id) DO NOTHING', [identity, observation.sourceType, observation.specId, observation.supplierId || null, observation.tradeId || null, observation.quoteId || null, observation.price, observation.quantity, observation.currency || 'KRW', observation.priceUnit || 'KRW_PER_KG', observation.quantityUnit || 'KG', observation.fulfilledAt || null, observation.evidenceStatus || null, JSON.stringify(observation)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async runAtomic(engine, mutation) {
    const client = await this.pool.connect();
    const inMemoryBefore = engine.snapshot();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('raw-material-os:ledger'))");
      const latest = await client.query('SELECT payload FROM ledger_snapshots ORDER BY snapshot_id DESC LIMIT 1');
      if (latest.rows[0]?.payload) engine.restore(latest.rows[0].payload);
      const result = mutation();
      const snapshot = engine.snapshot();
      await client.query('INSERT INTO ledger_snapshots(payload) VALUES ($1::jsonb)', [JSON.stringify(snapshot)]);
      await client.query('COMMIT');
      return { result, snapshot };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      engine.restore(inMemoryBefore);
      throw error;
    } finally {
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

export const createPersistenceStore = async ({ mode = 'memory', filePath = defaultFilePath, databaseUrl = process.env.DATABASE_URL } = {}) => {
  if (mode === 'postgresql') {
    if (!databaseUrl) throw new PersistenceStoreError('PostgreSQL DATABASE_URL이 없어 상용 원장을 시작할 수 없습니다.', 'POSTGRES_DATABASE_URL_REQUIRED');
    try {
      const { Pool } = await import('pg');
      const pool = new Pool({
        connectionString: databaseUrl,
        max: Number(process.env.PG_POOL_MAX || 20),
        idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 10000),
        connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 3000),
      });
      try {
        await pool.query('SELECT 1');
        const store = new PostgresSnapshotStore(pool);
        await store.verifySchema();
        return store;
      } catch (error) {
        await pool.end();
        throw error;
      }
    } catch (error) {
      if (error instanceof PersistenceStoreError) throw error;
      throw new PersistenceStoreError(`PostgreSQL 원장에 연결할 수 없습니다: ${error.message}`, 'POSTGRES_UNAVAILABLE');
    }
  }
  if (mode !== 'sqlite') return new MemoryStore();
  try {
    const { DatabaseSync } = await import('node:sqlite');
    await mkdir(dirname(filePath), { recursive: true });
    return new SqliteSnapshotStore(new DatabaseSync(filePath), filePath);
  } catch (error) {
    throw new PersistenceStoreError('SQLite 베타 영속 모드를 사용할 수 없습니다. --experimental-sqlite 런타임을 확인하세요.', 'SQLITE_UNAVAILABLE');
  }
};
