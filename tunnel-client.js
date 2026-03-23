/**
 * Tunnel Client — runs on Mac mini, connects outward to Railway relay,
 * forwards traffic to the local Eragon gateway.
 *
 * Env:
 *   RELAY_URL       — wss://relay-xxx.up.railway.app/tunnel?token=SECRET
 *   GATEWAY_URL     — ws://127.0.0.3:19789 (local Eragon gateway)
 *   TUNNEL_SECRET   — shared secret matching the relay
 */

'use strict';

const WebSocket = require('ws');

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
let gatewayWs = null;
let reconnectTimer = null;

function connectGateway() {
  if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) return gatewayWs;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    ws.on('open', () => {
      console.log(`[tunnel] Connected to local gateway: ${GATEWAY_URL}`);
      gatewayWs = ws;
      resolve(ws);
    });
    ws.on('error', (err) => {
      console.error('[tunnel] Gateway error:', err.message);
      reject(err);
    });
    ws.on('close', () => {
      console.log('[tunnel] Gateway connection closed');
      gatewayWs = null;
    });
  });
}

function connectRelay() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;

  console.log(`[tunnel] Connecting to relay: ${fullRelayUrl.replace(/token=.*/, 'token=***')}`);
  relayWs = new WebSocket(fullRelayUrl);

  relayWs.on('open', () => {
    console.log('[tunnel] Connected to relay');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  });

  relayWs.on('message', async (data) => {
    // Message from browser via relay → forward to local gateway
    try {
      if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
        await connectGateway();
      }

      // Forward to gateway
      gatewayWs.send(data.toString());

      // Set up response forwarding (one-time per gateway connection)
      if (!gatewayWs._relayForwardSetup) {
        gatewayWs._relayForwardSetup = true;
        gatewayWs.on('message', (gwData) => {
          if (relayWs && relayWs.readyState === WebSocket.OPEN) {
            relayWs.send(gwData.toString());
          }
        });
      }
    } catch (err) {
      console.error('[tunnel] Failed to forward to gateway:', err.message);
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify({ error: 'Gateway connection failed: ' + err.message }));
      }
    }
  });

  relayWs.on('close', (code, reason) => {
    console.log(`[tunnel] Relay disconnected (${code}). Reconnecting in 3s...`);
    relayWs = null;
    reconnectTimer = setTimeout(connectRelay, 3000);
  });

  relayWs.on('error', (err) => {
    console.error('[tunnel] Relay error:', err.message);
  });

  relayWs.on('ping', () => {
    relayWs.pong();
  });
}

// Start
connectRelay();

// Keep alive
process.on('SIGTERM', () => {
  console.log('[tunnel] Shutting down...');
  if (relayWs) relayWs.close();
  if (gatewayWs) gatewayWs.close();
  process.exit(0);
});
