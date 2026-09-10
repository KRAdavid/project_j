import { createHash } from 'node:crypto';

const clone = (value) => JSON.parse(JSON.stringify(value));

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

export const hashSnapshot = (value) => createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');

export const tradeIntegrityPayload = (trade) => ({
  tradeId: trade.tradeId,
  orderId: trade.orderId,
  buyerId: trade.buyerId,
  supplierId: trade.supplierId,
  supplierOrganizationId: trade.supplierOrganizationId,
  materialId: trade.materialId,
  specId: trade.specId,
  specSnapshot: clone(trade.specSnapshot),
  lotSnapshot: clone(trade.lotSnapshot),
  evidenceSnapshot: clone(trade.evidenceSnapshot),
  price: trade.price,
  quantity: trade.quantity,
  deliveryDate: trade.deliveryDate,
  preTradeChecks: clone(trade.preTradeChecks),
  reservationId: trade.reservationId,
  confirmedAt: trade.confirmedAt,
});

export const sealTradeSnapshot = (trade) => ({ ...trade, tradeSnapshotHash: hashSnapshot(tradeIntegrityPayload(trade)) });

export const verifyTradeSnapshot = (trade) => Boolean(trade?.tradeSnapshotHash) && hashSnapshot(tradeIntegrityPayload(trade)) === trade.tradeSnapshotHash;
