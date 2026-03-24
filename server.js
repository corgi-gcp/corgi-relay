/**
 * Corgi WS Relay v3 — Multi-tunnel, multi-team routing
 *
 * Architecture:
 *   Multiple Mac minis each run a tunnel client that connects here.
 *   Each tunnel registers with a unique tunnelId.
 *   Browsers connect and send a gateway auth message containing a token.
 *   The relay inspects the first message to extract the token, looks up
 *   which tunnel owns that token, and routes all subsequent traffic there.
 *
 * Tunnel registration:
 *   /tunnel?token=<TUNNEL_SECRET>&id=<TUNNEL_ID>
 *   The tunnelId is how the relay knows which tunnel to route to.
 *   Each tunnel also registers which gateway tokens it serves.
 *
 * Browser connection:
 *   /ws — browser connects, sends first gateway message (which contains the token)
 *   Relay parses the token from the auth handshake and routes to the right tunnel.
 *
 * Envelope format (relay ↔ tunnel):
 *   { sid: "browser-session-id", data: "raw-gateway-message" }
 *   { type: "browser_open", sid: "..." }
 *   { type: "browser_close", sid: "..." }
 *
 * Tunnel → relay registration:
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
const browsers = new Map();      // sid → { ws, tunnelId: string|null, queue: string[] }

// ── Fetch Railway projects ──
let appsCache = { data: null, ts: 0 };
const APPS_CACHE_TTL = 60_000; // 1 minute

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
            // Derive environment from domain
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

// ── CORS headers for dashboard ──
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
  res.end('Corgi Relay v3 — Multi-tunnel');
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

// ── Extract gateway token from the first browser message ──
// Gateway auth messages look like: {"id":N,"method":"auth","params":{"token":"..."}}
function extractToken(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg.method === 'auth' && msg.params?.token) {
      return msg.params.token;
    }
  } catch {}
  return null;
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
    const token = parsed.query.token || '';
    const tunnelId = parsed.query.id || crypto.randomUUID().slice(0, 8);

    if (token !== TUNNEL_SECRET) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Replace existing tunnel with same ID
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

        // Token registration: tunnel tells us which gateway tokens it serves
        if (envelope.type === 'register_tokens') {
          const newTokens = envelope.tokens || [];
          for (const t of newTokens) {
            tunnelEntry.tokens.add(t);
            tokenToTunnel.set(t, tunnelId);
          }
          console.log(`[relay] Tunnel '${tunnelId}' registered ${newTokens.length} token(s) (total: ${tunnelEntry.tokens.size})`);
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
      // Clean up token mappings
      for (const t of tunnelEntry.tokens) {
        if (tokenToTunnel.get(t) === tunnelId) {
          tokenToTunnel.delete(t);
        }
      }
      tunnels.delete(tunnelId);
    });

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(ping);
    }, 25000);
    return;
  }

  // ══════════════════════════════════════════════════════
  //  BROWSER CONNECTION
  // ══════════════════════════════════════════════════════
  if (path === '/ws') {
    const sid = crypto.randomUUID();
    const browserEntry = { ws, tunnelId: null, queue: [] };
    browsers.set(sid, browserEntry);
    console.log(`[relay] Browser ${sid.slice(0, 8)} connected (total: ${browsers.size})`);

    ws.on('message', (raw) => {
      const rawStr = raw.toString();

      // If not yet routed, try to extract token from first message
      if (!browserEntry.tunnelId) {
        const token = extractToken(rawStr);
        if (token) {
          const result = findTunnelForToken(token);
          if (result) {
            browserEntry.tunnelId = result.tunnelId;
            console.log(`[relay] Browser ${sid.slice(0, 8)} → tunnel '${result.tunnelId}'`);

            // Tell tunnel about new browser
            sendToTunnel(result.tunnelId, JSON.stringify({ type: 'browser_open', sid }));

            // Flush queued messages (including this one)
            for (const queued of browserEntry.queue) {
              sendToTunnel(result.tunnelId, JSON.stringify({ sid, data: queued }));
            }
            browserEntry.queue = [];

            // Send current message
            sendToTunnel(result.tunnelId, JSON.stringify({ sid, data: rawStr }));
            return;
          }
        }

        // Token not recognized or no tunnel — queue the message
        // (tunnel might connect soon, or browser might send auth later)
        browserEntry.queue.push(rawStr);

        // If we have exactly one tunnel (backward compat), route there
        if (tunnels.size === 1) {
          const [onlyTunnelId, onlyTunnel] = [...tunnels.entries()][0];
          if (onlyTunnel.ws.readyState === WebSocket.OPEN) {
            browserEntry.tunnelId = onlyTunnelId;
            console.log(`[relay] Browser ${sid.slice(0, 8)} → tunnel '${onlyTunnelId}' (single-tunnel fallback)`);

            sendToTunnel(onlyTunnelId, JSON.stringify({ type: 'browser_open', sid }));
            for (const queued of browserEntry.queue) {
              sendToTunnel(onlyTunnelId, JSON.stringify({ sid, data: queued }));
            }
            browserEntry.queue = [];
            return;
          }
        }

        // No tunnel available
        if (tunnels.size === 0) {
          ws.send(JSON.stringify({
            error: 'No gateway tunnels connected. Your Mac mini may be offline.',
          }));
        }
        return;
      }

      // Already routed — forward to tunnel
      if (!sendToTunnel(browserEntry.tunnelId, JSON.stringify({ sid, data: rawStr }))) {
        ws.send(JSON.stringify({
          error: 'Gateway tunnel disconnected. Your Mac mini may be offline.',
        }));
        browserEntry.tunnelId = null; // Allow re-routing on next message
      }
    });

    ws.on('close', () => {
      browsers.delete(sid);
      console.log(`[relay] Browser ${sid.slice(0, 8)} disconnected (total: ${browsers.size})`);
      // Tell tunnel
      if (browserEntry.tunnelId) {
        sendToTunnel(browserEntry.tunnelId, JSON.stringify({ type: 'browser_close', sid }));
      }
    });
    return;
  }

  ws.close(4004, 'Unknown path');
});

server.listen(PORT, () => {
  console.log(`[relay] Corgi Relay v3 on port ${PORT}`);
});
