/**
 * Corgi WS Relay v2 — per-browser-session multiplexing
 *
 * Each browser gets a unique sessionId. The relay wraps all messages
 * with the sessionId so the tunnel client can maintain separate
 * gateway connections per browser.
 *
 * Browser → relay: raw gateway messages
 * Relay → tunnel: { sid: "xxx", data: "..." }
 * Tunnel → relay: { sid: "xxx", data: "..." }
 * Relay → browser: raw gateway messages (routed by sid)
 */

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || 'corgi-tunnel-2026';

let tunnelSocket = null;
const browsers = new Map(); // sid → ws

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      healthy: true,
      tunnel: tunnelSocket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      browsers: browsers.size,
    }));
    return;
  }
  res.writeHead(200);
  res.end('Corgi Relay v2');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const token = parsed.query.token || '';

  // ── Tunnel (Mac mini) ──
  if (path === '/tunnel') {
    if (token !== TUNNEL_SECRET) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
      tunnelSocket.close(1000, 'replaced');
    }
    tunnelSocket = ws;
    console.log('[relay] Tunnel connected');

    ws.on('message', (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        const { sid, data } = envelope;
        const browser = browsers.get(sid);
        if (browser && browser.readyState === WebSocket.OPEN) {
          browser.send(data);
        }
      } catch (e) {
        console.error('[relay] Bad tunnel message:', e.message);
      }
    });

    ws.on('close', () => {
      console.log('[relay] Tunnel disconnected');
      if (tunnelSocket === ws) tunnelSocket = null;
    });

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(ping);
    }, 25000);
    return;
  }

  // ── Browser ──
  if (path === '/ws') {
    const sid = crypto.randomUUID();
    browsers.set(sid, ws);
    console.log(`[relay] Browser ${sid.slice(0,8)} connected (total: ${browsers.size})`);

    // Tell tunnel a new browser connected
    if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
      tunnelSocket.send(JSON.stringify({ type: 'browser_open', sid }));
    }

    ws.on('message', (raw) => {
      if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
        tunnelSocket.send(JSON.stringify({ sid, data: raw.toString() }));
      } else {
        ws.send(JSON.stringify({
          error: 'Gateway tunnel not connected. Mac mini may be offline.',
        }));
      }
    });

    ws.on('close', () => {
      browsers.delete(sid);
      console.log(`[relay] Browser ${sid.slice(0,8)} disconnected (total: ${browsers.size})`);
      // Tell tunnel browser disconnected
      if (tunnelSocket && tunnelSocket.readyState === WebSocket.OPEN) {
        tunnelSocket.send(JSON.stringify({ type: 'browser_close', sid }));
      }
    });
    return;
  }

  ws.close(4004, 'Unknown path');
});

server.listen(PORT, () => {
  console.log(`[relay] Corgi Relay v2 on port ${PORT}`);
});
