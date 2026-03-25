/**
 * Tunnel Client v3 — Multi-tunnel aware
 *
 * Each Mac mini runs one of these. It connects to the shared relay with a
 * unique TUNNEL_ID and registers the GATEWAY_TOKEN(s) it serves.
 * The relay uses these tokens to route browser sessions to the right tunnel.
 *
 * Env vars:
 *   RELAY_URL       — wss://relay-production-724a.up.railway.app
 *   GATEWAY_URL     — ws://127.0.0.3:19789  (local gateway)
 *   GATEWAY_TOKEN   — the auth token for this gateway (sent to relay for routing)
 *   TUNNEL_SECRET   — shared secret to authenticate with relay
 *   TUNNEL_ID       — unique identifier for this tunnel (e.g., "josh", "ta", "cr")
 *   DASHBOARD_ORIGIN — Origin header for gateway connections (default: production dashboard)
 */

'use strict';

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const RELAY_URL = process.env.RELAY_URL || '';
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.3:19789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || 'corgi-tunnel-2026';
const TUNNEL_ID = process.env.TUNNEL_ID || 'default';
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || 'https://dashboard-production-3553.up.railway.app';
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/Users/corgi12/.eragon-joshua_augustine/joshua_augustine_workspace';

// ── MIME type map ──
const MIME_TYPES = {
  '.pdf':  'application/pdf',
  '.txt':  'text/plain',
  '.md':   'text/markdown',
  '.json': 'application/json',
  '.csv':  'text/csv',
  '.js':   'application/javascript',
  '.ts':   'application/typescript',
  '.py':   'text/x-python',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.zip':  'application/zip',
  '.html': 'text/html',
  '.css':  'text/css',
};

// ── Handle file_request from relay ──
async function handleFileRequest(requestId, filePath) {
  function sendResponse(payload) {
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify(payload));
    }
  }

  try {
    // Resolve relative to workspace
    const resolved = path.resolve(WORKSPACE_DIR, filePath);

    // Validate path stays within workspace
    if (!resolved.startsWith(path.resolve(WORKSPACE_DIR) + path.sep) &&
        resolved !== path.resolve(WORKSPACE_DIR)) {
      sendResponse({ type: 'file_response', requestId, status: 'error', error: 'Path outside workspace' });
      return;
    }

    // Check existence + size
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      sendResponse({ type: 'file_response', requestId, status: 'error', error: 'File not found' });
      return;
    }

    if (!stat.isFile()) {
      sendResponse({ type: 'file_response', requestId, status: 'error', error: 'Not a file' });
      return;
    }

    const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
    if (stat.size > MAX_SIZE) {
      sendResponse({ type: 'file_response', requestId, status: 'error', error: 'File exceeds 50 MB limit' });
      return;
    }

    const data = fs.readFileSync(resolved).toString('base64');
    const ext = path.extname(resolved).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileName = path.basename(resolved);

    sendResponse({ type: 'file_response', requestId, status: 'ok', data, mimeType, fileName });
    console.log(`[tunnel:${TUNNEL_ID}] Served file '${fileName}' (${stat.size} bytes)`);
  } catch (e) {
    sendResponse({ type: 'file_response', requestId, status: 'error', error: e.message || 'Unknown error' });
  }
}

if (!RELAY_URL) {
  console.error('[tunnel] RELAY_URL is required');
  process.exit(1);
}

if (!GATEWAY_TOKEN) {
  console.warn('[tunnel] WARNING: GATEWAY_TOKEN not set — relay won\'t route browsers to this tunnel');
}

const fullRelayUrl = `${RELAY_URL.replace(/\/+$/, '')}/tunnel?token=${encodeURIComponent(TUNNEL_SECRET)}&id=${encodeURIComponent(TUNNEL_ID)}`;

let relayWs = null;
const gateways = new Map(); // sid → { ws, ready, queue }

function openGateway(sid) {
  if (gateways.has(sid)) return;

  const entry = { ws: null, ready: false, queue: [] };
  gateways.set(sid, entry);

  console.log(`[tunnel:${TUNNEL_ID}] Opening gateway for browser ${sid.slice(0, 8)}`);
  const ws = new WebSocket(GATEWAY_URL, {
    headers: { Origin: DASHBOARD_ORIGIN },
  });
  entry.ws = ws;

  ws.on('open', () => {
    console.log(`[tunnel:${TUNNEL_ID}] Gateway open for ${sid.slice(0, 8)}`);
    entry.ready = true;
    for (const msg of entry.queue) {
      ws.send(msg);
    }
    entry.queue = [];
  });

  ws.on('message', (data) => {
    const str = typeof data === 'string' ? data : data.toString();
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify({ sid, data: str }));
    }
  });

  ws.on('close', () => {
    console.log(`[tunnel:${TUNNEL_ID}] Gateway closed for ${sid.slice(0, 8)}`);
    gateways.delete(sid);
  });

  ws.on('error', (e) => {
    console.error(`[tunnel:${TUNNEL_ID}] Gateway error for ${sid.slice(0, 8)}:`, e.message || 'failed');
  });
}

function closeGateway(sid) {
  const entry = gateways.get(sid);
  if (entry) {
    entry.ws?.close();
    gateways.delete(sid);
    console.log(`[tunnel:${TUNNEL_ID}] Closed gateway for ${sid.slice(0, 8)}`);
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

function registerTokens() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;
  if (!GATEWAY_TOKEN) return;

  const tokens = GATEWAY_TOKEN.split(',').map((t) => t.trim()).filter(Boolean);
  relayWs.send(JSON.stringify({ type: 'register_tokens', tokens }));
  console.log(`[tunnel:${TUNNEL_ID}] Registered ${tokens.length} token(s) with relay`);
}

function connectRelay() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;

  console.log(`[tunnel:${TUNNEL_ID}] Connecting to relay...`);
  relayWs = new WebSocket(fullRelayUrl);

  relayWs.on('open', () => {
    console.log(`[tunnel:${TUNNEL_ID}] ✓ Connected to relay`);
    // Register our gateway token(s) so the relay can route browsers to us
    registerTokens();
  });

  relayWs.on('message', (raw) => {
    const str = typeof raw === 'string' ? raw : raw.toString();
    try {
      const envelope = JSON.parse(str);

      if (envelope.type === 'browser_open') {
        openGateway(envelope.sid);
        return;
      }
      if (envelope.type === 'browser_close') {
        closeGateway(envelope.sid);
        return;
      }
      if (envelope.type === 'file_request') {
        handleFileRequest(envelope.requestId, envelope.filePath);
        return;
      }
      if (envelope.sid && envelope.data) {
        forwardToGateway(envelope.sid, envelope.data);
        return;
      }
    } catch (e) {
      console.error(`[tunnel:${TUNNEL_ID}] Parse error:`, e.message);
    }
  });

  relayWs.on('close', (code) => {
    console.log(`[tunnel:${TUNNEL_ID}] Relay disconnected (${code}). Reconnecting in 3s...`);
    relayWs = null;
    for (const [, entry] of gateways) entry.ws?.close();
    gateways.clear();
    setTimeout(connectRelay, 3000);
  });

  relayWs.on('error', (e) => {
    console.error(`[tunnel:${TUNNEL_ID}] Relay error:`, e.message || 'failed');
  });
}

connectRelay();
setInterval(() => {}, 30000); // Keep process alive

process.on('SIGTERM', () => {
  console.log(`[tunnel:${TUNNEL_ID}] Shutting down...`);
  relayWs?.close();
  for (const [, entry] of gateways) entry.ws?.close();
  process.exit(0);
});
