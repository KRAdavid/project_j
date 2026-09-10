export const createSseFrame = (eventName, payload, eventId = '') => {
  const idLine = eventId ? `id: ${eventId}\n` : '';
  return `${idLine}event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
};

export class SseEventBroker {
  constructor({ heartbeatPayload = { dataStatus: 'SIMULATED_BACKEND' } } = {}) {
    this.clients = new Map();
    this.heartbeatPayload = heartbeatPayload;
  }

  add(response, transform = (payload) => payload) {
    this.clients.set(response, transform);
    return () => this.clients.delete(response);
  }

  send(response, eventName, payload, eventId = '') {
    try { response.write(createSseFrame(eventName, payload, eventId)); } catch { this.clients.delete(response); }
  }

  publish(eventName, payload, eventId = '') {
    for (const [client, transform] of this.clients) this.send(client, eventName, transform(payload), eventId);
  }

  heartbeat() {
    this.publish('heartbeat', this.heartbeatPayload);
  }
}
