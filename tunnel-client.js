/**
 * Tunnel Client v2 — maintains a SEPARATE gateway WS per browser session.
 *
 * Relay sends envelopes: { sid, data } or { type: "browser_open/close", sid }
 * For each browser sid, we open a dedicated gateway connection.
 * Gateway responses are wrapped back: { sid, data } → relay → browser
 */

'use strict';

const RELAY_URL = process.env.RELAY_URL || '';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.3:19789';
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || 'corgi-tunnel-2026';

if (!RELAY_URL) {
  console.error('[tunnel] RELAY_URL is required');
  process.exit(1);
}

const fullRelayUrl = RELAY_URL.includes('?')
  ? RELAY_URL
  : `${RELAY_URL}/tunnel?token=${TUNNEL_SECRET}`;

let relayWs = null;
const gateways = new Map(); // sid → { ws, ready, queue }

function openGateway(sid) {
  if (gateways.has(sid)) return;

  const entry = { ws: null, ready: false, queue: [] };
  gateways.set(sid, entry);

  console.log(`[tunnel] Opening gateway for browser ${sid.slice(0,8)}`);
  const ws = new WebSocket(GATEWAY_URL);
  entry.ws = ws;

  ws.addEventListener('open', () => {
    console.log(`[tunnel] Gateway open for ${sid.slice(0,8)}`);
    entry.ready = true;
    // Flush queued messages
    for (const msg of entry.queue) {
      ws.send(msg);
    }
    entry.queue = [];
  });

  ws.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : event.data.toString();
    // Send back to relay with sid envelope
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify({ sid, data }));
    }
  });

  ws.addEventListener('close', () => {
    console.log(`[tunnel] Gateway closed for ${sid.slice(0,8)}`);
    gateways.delete(sid);
  });

  ws.addEventListener('error', (e) => {
    console.error(`[tunnel] Gateway error for ${sid.slice(0,8)}:`, e.message || 'failed');
  });
}

function closeGateway(sid) {
  const entry = gateways.get(sid);
  if (entry) {
    entry.ws?.close();
    gateways.delete(sid);
    console.log(`[tunnel] Closed gateway for ${sid.slice(0,8)}`);
  }
}

function forwardToGateway(sid, data) {
  let entry = gateways.get(sid);
  if (!entry) {
    openGateway(sid);
    entry = gateways.get(sid);
  }
  if (entry.ready) {
    entry.ws.send(data);
  } else {
    entry.queue.push(data);
  }
}

function connectRelay() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;

  console.log('[tunnel] Connecting to relay...');
  relayWs = new WebSocket(fullRelayUrl);

  relayWs.addEventListener('open', () => {
    console.log('[tunnel] ✓ Connected to relay');
  });

  relayWs.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : event.data.toString();
    try {
      const envelope = JSON.parse(raw);

      if (envelope.type === 'browser_open') {
        openGateway(envelope.sid);
        return;
      }
      if (envelope.type === 'browser_close') {
        closeGateway(envelope.sid);
        return;
      }
      if (envelope.sid && envelope.data) {
        forwardToGateway(envelope.sid, envelope.data);
        return;
      }
    } catch (e) {
      console.error('[tunnel] Parse error:', e.message);
    }
  });

  relayWs.addEventListener('close', (event) => {
    console.log(`[tunnel] Relay disconnected (${event.code}). Reconnecting in 3s...`);
    relayWs = null;
    // Close all gateway connections
    for (const [sid, entry] of gateways) {
      entry.ws?.close();
    }
    gateways.clear();
    setTimeout(connectRelay, 3000);
  });

  relayWs.addEventListener('error', (e) => {
    console.error('[tunnel] Relay error:', e.message || 'failed');
  });
}

connectRelay();
setInterval(() => {}, 30000);

process.on('SIGTERM', () => {
  console.log('[tunnel] Shutting down...');
  relayWs?.close();
  for (const [, entry] of gateways) entry.ws?.close();
  process.exit(0);
});
