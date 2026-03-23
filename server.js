/**
 * Corgi WS Relay — bridges browser ↔ Mac mini gateway
 *
 * Architecture:
 *   Mac mini (tunnel client) → connects to /tunnel?token=SECRET
 *   Browser (dashboard)      → connects to /ws?token=GATEWAY_TOKEN
 *   Relay forwards messages bidirectionally between them.
 *
 * Env:
 *   PORT           — HTTP port (Railway sets this)
 *   TUNNEL_SECRET  — shared secret the Mac mini tunnel client uses
 */

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');

const PORT = process.env.PORT || 3001;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || 'corgi-tunnel-2026';

// ── State ──────────────────────────────────────────────────────────────────────

let tunnelSocket = null;          // The single Mac mini tunnel connection
const browserSockets = new Set(); // All connected browser clients
let pendingRequests = new Map();  // reqId → browser socket (for request/response pairing)
let reqCounter = 0;

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      healthy: true,
      tunnel: tunnelSocket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      browsers: browserSockets.size,
    }));
    return;
  }
  res.writeHead(200);
  res.end('Corgi Relay');
});

// ── WebSocket server ───────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const token = parsed.query.token || '';

  // ── Tunnel connection (Mac mini) ───────────────────────────────────────────
  if (path === '/tunnel') {
    if (token !== TUNNEL_SECRET) {
      console.log('[relay] Tunnel auth failed');
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Replace old tunnel if exists
    if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
      console.log('[relay] Replacing old tunnel connection');
      tunnelSocket.close(1000, 'replaced');
    }

    tunnelSocket = ws;
    console.log('[relay] Tunnel connected from Mac mini');

    ws.on('message', (data) => {
      // Forward gateway response to ALL connected browsers
      const msg = data.toString();
      for (const browser of browserSockets) {
        if (browser.readyState === WebSocket.OPEN) {
          browser.send(msg);
        }
      }
    });

    ws.on('close', () => {
      console.log('[relay] Tunnel disconnected');
      if (tunnelSocket === ws) tunnelSocket = null;
    });

    ws.on('error', (err) => {
      console.error('[relay] Tunnel error:', err.message);
    });

    // Send a ping every 25s to keep the connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(pingInterval);
    }, 25000);

    return;
  }

  // ── Browser connection (dashboard frontend) ────────────────────────────────
  if (path === '/ws') {
    browserSockets.add(ws);
    console.log(`[relay] Browser connected (total: ${browserSockets.size})`);

    ws.on('message', (data) => {
      // Forward browser message to the tunnel (Mac mini gateway)
      if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
        tunnelSocket.send(data.toString());
      } else {
        // No tunnel — send error back
        ws.send(JSON.stringify({
          error: 'Gateway tunnel not connected. The Mac mini may be offline.',
        }));
      }
    });

    ws.on('close', () => {
      browserSockets.delete(ws);
      console.log(`[relay] Browser disconnected (total: ${browserSockets.size})`);
    });

    ws.on('error', (err) => {
      console.error('[relay] Browser error:', err.message);
      browserSockets.delete(ws);
    });

    return;
  }

  // Unknown path
  ws.close(4004, 'Unknown path');
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[relay] Corgi Relay listening on port ${PORT}`);
  console.log(`[relay] Tunnel endpoint: /tunnel?token=<secret>`);
  console.log(`[relay] Browser endpoint: /ws`);
});
