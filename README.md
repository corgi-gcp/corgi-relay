# Corgi Tunnel Client

Connects your Mac mini's Eragon gateway to the shared Corgi Relay on Railway.

## Setup

1. Install dependencies:
```bash
npm install ws
```

2. Create a `.env` file:
```bash
RELAY_URL=wss://relay-production-724a.up.railway.app
GATEWAY_URL=ws://127.0.0.3:19789
GATEWAY_TOKEN=<your-gateway-token-from-eragon.json>
TUNNEL_SECRET=corgi-tunnel-2026
TUNNEL_ID=<your-name>
DASHBOARD_ORIGIN=https://dashboard-production-3553.up.railway.app
```

3. Run:
```bash
source .env && node tunnel-client.js
```

4. Verify at: https://relay-production-724a.up.railway.app/health
   - You should see your tunnel ID in `tunnelDetails`

## What it does

Your browser → Dashboard (Railway) → Relay (Railway) → This tunnel → Your local Eragon gateway

The relay routes each browser to the correct tunnel using the gateway token. Each team member's tunnel registers its own token, so traffic is fully isolated.
