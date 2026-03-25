/**
 * Corgi WS Relay v3.1 — Multi-tunnel, multi-team routing
 *
 * Architecture:
 *   Multiple Mac minis each run a tunnel client that connects here.
 *   Each tunnel registers with a unique tunnelId and declares its gateway tokens.
 *
 * Routing:
 *   Browsers connect to /ws?token=<GATEWAY_TOKEN>
 *   The relay matches the token to a tunnel and routes immediately.
 *   This is critical because the Eragon gateway protocol requires the SERVER
 *   to speak first (sends a connect.challenge), so the relay can't wait for
 *   the browser's first message to decide routing.
 *
 * Fallback:
 *   If only one tunnel is connected, all browsers route there (backward compat).
 *
 * Envelope format (relay ↔ tunnel):
 *   { sid: "browser-session-id", data: "raw-gateway-message" }
 *   { type: "browser_open", sid: "..." }
 *   { type: "browser_close", sid: "..." }
 *
 * Tunnel registration:
 *   { type: "register_tokens", tokens: ["token1", "token2"] }
 */

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || 'corgi-tunnel-2026';
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || '';
const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

// Known project IDs to query
const PROJECT_IDS = (process.env.RAILWAY_PROJECT_IDS || '').split(',').filter(Boolean);

// ── State ──
const tunnels = new Map();      // tunnelId → { ws, tokens: Set<string> }
const tokenToTunnel = new Map(); // gatewayToken → tunnelId
const browsers = new Map();      // sid → { ws, tunnelId: string|null }

// ── Fetch Railway projects ──
let appsCache = { data: null, ts: 0 };
const APPS_CACHE_TTL = 60_000;

async function fetchRailwayApps() {
  if (!RAILWAY_TOKEN || PROJECT_IDS.length === 0) return null;
  if (appsCache.data && Date.now() - appsCache.ts < APPS_CACHE_TTL) return appsCache.data;

  const projects = [];
  for (const pid of PROJECT_IDS) {
    try {
      const resp = await fetch(RAILWAY_API, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RAILWAY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `{ project(id: "${pid}") { id name services { edges { node { name serviceInstances { edges { node { domains { serviceDomains { domain } } latestDeployment { status } } } } } } } } }`,
        }),
      });
      const json = await resp.json();
      const proj = json?.data?.project;
      if (!proj) continue;

      const services = [];
      for (const s of proj.services.edges) {
        const svc = s.node;
        const instances = [];
        for (const si of svc.serviceInstances.edges) {
          const inst = si.node;
          const status = inst.latestDeployment?.status || 'unknown';
          for (const sd of inst.domains.serviceDomains) {
            let env = 'production';
            if (sd.domain.includes('-staging')) env = 'staging';
            else if (sd.domain.includes('-dev') || sd.domain.includes('feature')) env = 'dev';
            instances.push({ environment: env, domain: sd.domain, status });
          }
        }
        if (instances.length > 0) {
          services.push({ name: svc.name, instances });
        }
      }
      projects.push({ name: proj.name, id: proj.id, services });
    } catch (e) {
      console.error(`[relay] Failed to fetch project ${pid}:`, e.message);
    }
  }

  appsCache = { data: { projects }, ts: Date.now() };
  return appsCache.data;
}

// ── CORS headers ──
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── HTTP endpoints ──
const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/api/apps') {
    const data = await fetchRailwayApps();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data || { projects: [] }));
    return;
  }

  if (req.url === '/health') {
    const tunnelStatus = {};
    for (const [id, t] of tunnels) {
      tunnelStatus[id] = {
        connected: t.ws.readyState === WebSocket.OPEN,
        tokens: t.tokens.size,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      healthy: true,
      tunnels: tunnels.size,
      browsers: browsers.size,
      tunnelDetails: tunnelStatus,
    }));
    return;
  }

  res.writeHead(200);
  res.end('Corgi Relay v3.1');
});

const wss = new WebSocketServer({ server });

// ── Find tunnel for a gateway token ──
function findTunnelForToken(token) {
  const tunnelId = tokenToTunnel.get(token);
  if (!tunnelId) return null;
  const tunnel = tunnels.get(tunnelId);
  if (!tunnel || tunnel.ws.readyState !== WebSocket.OPEN) return null;
  return { tunnelId, tunnel };
}

// ── Get single tunnel (fallback) ──
function getSingleTunnel() {
  if (tunnels.size !== 1) return null;
  const [tunnelId, tunnel] = [...tunnels.entries()][0];
  if (tunnel.ws.readyState !== WebSocket.OPEN) return null;
  return tunnelId;
}

// ── Send to tunnel ──
function sendToTunnel(tunnelId, data) {
  const tunnel = tunnels.get(tunnelId);
  if (tunnel && tunnel.ws.readyState === WebSocket.OPEN) {
    tunnel.ws.send(data);
    return true;
  }
  return false;
}

wss.on('connection', (ws, req) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  // ══════════════════════════════════════════════════════
  //  TUNNEL CONNECTION
  // ══════════════════════════════════════════════════════
  if (path === '/tunnel') {
    const secret = parsed.query.token || '';
    const tunnelId = parsed.query.id || crypto.randomUUID().slice(0, 8);

    if (secret !== TUNNEL_SECRET) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const existing = tunnels.get(tunnelId);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(1000, 'replaced');
    }

    const tunnelEntry = { ws, tokens: new Set() };
    tunnels.set(tunnelId, tunnelEntry);
    console.log(`[relay] Tunnel '${tunnelId}' connected (total: ${tunnels.size})`);

    ws.on('message', (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());

        // Heartbeat — just ack and keep connection active
        if (envelope.type === 'heartbeat') {
          ws.send(JSON.stringify({ type: 'heartbeat_ack', ts: Date.now() }));
          return;
        }

        // Token registration
        if (envelope.type === 'register_tokens') {
          const newTokens = envelope.tokens || [];
          for (const t of newTokens) {
            tunnelEntry.tokens.add(t);
            tokenToTunnel.set(t, tunnelId);
          }
          console.log(`[relay] Tunnel '${tunnelId}' registered ${newTokens.length} token(s)`);
          return;
        }

        // Normal envelope: route to browser
        const { sid, data } = envelope;
        const browser = browsers.get(sid);
        if (browser && browser.ws.readyState === WebSocket.OPEN) {
          browser.ws.send(data);
        }
      } catch (e) {
        console.error('[relay] Bad tunnel message:', e.message);
      }
    });

    ws.on('close', () => {
      console.log(`[relay] Tunnel '${tunnelId}' disconnected`);
      for (const t of tunnelEntry.tokens) {
        if (tokenToTunnel.get(t) === tunnelId) {
          tokenToTunnel.delete(t);
        }
      }
      tunnels.delete(tunnelId);
    });

    // Keepalive with stale detection
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { clearInterval(ping); return; }
      if (!alive) {
        console.log(`[relay] Tunnel '${tunnelId}' missed pong — terminating`);
        ws.terminate();
        clearInterval(ping);
        return;
      }
      alive = false;
      ws.ping();
    }, 20000);
    return;
  }

  // ══════════════════════════════════════════════════════
  //  BROWSER CONNECTION
  // ══════════════════════════════════════════════════════
  if (path === '/ws') {
    const sid = crypto.randomUUID();

    // Route immediately on connect — the gateway speaks first (challenge),
    // so we can't wait for a browser message to decide routing.
    const browserToken = parsed.query.token || '';
    let targetTunnelId = null;

    // Try token-based routing first
    if (browserToken) {
      const result = findTunnelForToken(browserToken);
      if (result) {
        targetTunnelId = result.tunnelId;
        console.log(`[relay] Browser ${sid.slice(0, 8)} → tunnel '${targetTunnelId}' (token match)`);
      }
    }

    // Fallback: single tunnel
    if (!targetTunnelId) {
      targetTunnelId = getSingleTunnel();
      if (targetTunnelId) {
        console.log(`[relay] Browser ${sid.slice(0, 8)} → tunnel '${targetTunnelId}' (single-tunnel fallback)`);
      }
    }

    if (!targetTunnelId) {
      console.log(`[relay] Browser ${sid.slice(0, 8)} rejected — no matching tunnel`);
      ws.send(JSON.stringify({
        error: 'No gateway tunnel available. Your Mac mini may be offline.',
      }));
      ws.close(4002, 'No tunnel available');
      return;
    }

    const browserEntry = { ws, tunnelId: targetTunnelId };
    browsers.set(sid, browserEntry);
    console.log(`[relay] Browser ${sid.slice(0, 8)} connected (total: ${browsers.size})`);

    // Tell tunnel to open a gateway connection for this browser
    sendToTunnel(targetTunnelId, JSON.stringify({ type: 'browser_open', sid }));

    ws.on('message', (raw) => {
      const rawStr = raw.toString();
      if (!sendToTunnel(browserEntry.tunnelId, JSON.stringify({ sid, data: rawStr }))) {
        ws.send(JSON.stringify({
          error: 'Gateway tunnel disconnected. Your Mac mini may be offline.',
        }));
      }
    });

    ws.on('close', () => {
      browsers.delete(sid);
      console.log(`[relay] Browser ${sid.slice(0, 8)} disconnected (total: ${browsers.size})`);
      sendToTunnel(browserEntry.tunnelId, JSON.stringify({ type: 'browser_close', sid }));
    });
    return;
  }

  ws.close(4004, 'Unknown path');
});

server.listen(PORT, () => {
  console.log(`[relay] Corgi Relay v3.1 on port ${PORT}`);
});
