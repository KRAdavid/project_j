const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

const asId = (value) => String(value ?? '').trim();

const collection = (snapshot, name) => (Array.isArray(snapshot?.[name]) ? snapshot[name] : []);

const indexById = (items, idField, collectionName, issues) => {
  const index = new Map();
  for (const item of items) {
    const id = asId(item?.[idField]);
    if (!id) {
      issues.push({ code: 'IDENTIFIER_MISSING', collection: collectionName, idField });
      continue;
    }
    if (index.has(id)) issues.push({ code: 'DUPLICATE_IDENTIFIER', collection: collectionName, id });
    index.set(id, item);
  }
  return index;
};

const comparable = (record, fields) => Object.fromEntries(fields.map((field) => [field, record?.[field] ?? null]));

const compareCollection = ({ bridgeSnapshot, domainSnapshot, name, idField, fields, issues }) => {
  const bridgeItems = collection(bridgeSnapshot, name);
  const domainItems = collection(domainSnapshot, name);
  const bridgeIndex = indexById(bridgeItems, idField, name, issues);
  const domainIndex = indexById(domainItems, idField, name, issues);
  for (const id of bridgeIndex.keys()) {
    if (!domainIndex.has(id)) {
      issues.push({ code: 'DOMAIN_RECORD_MISSING', collection: name, id });
      continue;
    }
    const expected = comparable(bridgeIndex.get(id), fields);
    const actual = comparable(domainIndex.get(id), fields);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) issues.push({ code: 'FIELD_MISMATCH', collection: name, id, expected, actual });
  }
  for (const id of domainIndex.keys()) {
    if (!bridgeIndex.has(id)) issues.push({ code: 'BRIDGE_RECORD_MISSING', collection: name, id });
  }
  return { collection: name, bridgeCount: bridgeIndex.size, domainCount: domainIndex.size };
};

const checkDomainInvariants = (domainSnapshot, issues) => {
  for (const lot of collection(domainSnapshot, 'lots')) {
    const available = Number(lot.availableQty);
    const reserved = Number(lot.reservedQty);
    if (!Number.isFinite(available) || available < 0) issues.push({ code: 'LOT_AVAILABLE_INVALID', collection: 'lots', id: asId(lot.lotId) });
    if (!Number.isFinite(reserved) || reserved < 0) issues.push({ code: 'LOT_RESERVED_INVALID', collection: 'lots', id: asId(lot.lotId) });
  }
  const orderIds = new Set(collection(domainSnapshot, 'orders').map((order) => asId(order.orderId)));
  const lotIds = new Set(collection(domainSnapshot, 'lots').map((lot) => asId(lot.lotId)));
  for (const trade of collection(domainSnapshot, 'trades')) {
    if (!orderIds.has(asId(trade.orderId))) issues.push({ code: 'TRADE_ORDER_MISSING', collection: 'trades', id: asId(trade.tradeId) });
    if (!lotIds.has(asId(trade.lotId))) issues.push({ code: 'TRADE_LOT_MISSING', collection: 'trades', id: asId(trade.tradeId) });
    if (!asId(trade.tradeSnapshotHash)) issues.push({ code: 'TRADE_SNAPSHOT_HASH_MISSING', collection: 'trades', id: asId(trade.tradeId) });
  }
};

export const reconcileDomainState = ({ bridgeSnapshot, domainSnapshot } = {}) => {
  const checkedAt = new Date().toISOString();
  if (!bridgeSnapshot || typeof bridgeSnapshot !== 'object' || Array.isArray(bridgeSnapshot)) {
    return { status: 'NO_REFERENCE', safe: false, checkedAt, issueCount: 1, issues: [{ code: 'BRIDGE_REFERENCE_MISSING' }], comparedCollections: [] };
  }
  if (!domainSnapshot || typeof domainSnapshot !== 'object' || Array.isArray(domainSnapshot)) {
    return { status: 'MISMATCH', safe: false, checkedAt, issueCount: 1, issues: [{ code: 'DOMAIN_STATE_MISSING' }], comparedCollections: [] };
  }
  const issues = [];
  const comparedCollections = [
    compareCollection({ bridgeSnapshot, domainSnapshot, name: 'lots', idField: 'lotId', fields: ['lotId', 'specId', 'status', 'availableQty', 'reservedQty'], issues }),
    compareCollection({ bridgeSnapshot, domainSnapshot, name: 'orders', idField: 'orderId', fields: ['orderId', 'specId', 'status', 'price', 'quantity', 'deliveryDate'], issues }),
    compareCollection({ bridgeSnapshot, domainSnapshot, name: 'trades', idField: 'tradeId', fields: ['tradeId', 'orderId', 'lotId', 'specId', 'status', 'price', 'quantity', 'deliveryDate', 'tradeSnapshotHash'], issues }),
  ];
  checkDomainInvariants(domainSnapshot, issues);
  return { status: issues.length ? 'MISMATCH' : 'MATCH', safe: issues.length === 0, checkedAt, issueCount: issues.length, issues, comparedCollections, bridgeDataStatus: bridgeSnapshot.dataStatus || null, domainDataStatus: domainSnapshot.dataStatus || null };
};

export const reconciliationFingerprint = (result) => JSON.stringify({ status: result?.status, issueCount: result?.issueCount, issues: clone(result?.issues || []) });
