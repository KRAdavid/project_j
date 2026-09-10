import assert from 'node:assert/strict';
import { createSseFrame, SseEventBroker } from './event-broker.mjs';

const frame = createSseFrame('ledger', { ok: true }, 'EVENT-001');
assert.match(frame, /^id: EVENT-001\nevent: ledger\ndata: \{"ok":true\}\n\n$/);

const broker = new SseEventBroker();
const writes = [];
const remove = broker.add({ write: (value) => writes.push(value) });
broker.publish('snapshot', { dataStatus: 'SIMULATED_BACKEND' }, 'EVENT-002');
assert.equal(writes.length, 1);
assert.match(writes[0], /event: snapshot/);
broker.send({ write: (value) => writes.push(value) }, 'heartbeat', { dataStatus: 'SIMULATED_BACKEND' });
assert.equal(writes.length, 2, '초기 스냅샷은 지정한 연결에만 보낼 수 있어야 합니다.');
remove();
broker.publish('heartbeat', { dataStatus: 'SIMULATED_BACKEND' });
assert.equal(writes.length, 2, '연결 해제된 클라이언트에는 이벤트를 보내면 안 됩니다.');

console.log('event-broker tests: PASS');
