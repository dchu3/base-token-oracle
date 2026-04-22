# base-token-oracle

![Node](https://img.shields.io/badge/node-20.x-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![x402](https://img.shields.io/badge/x402-v2-black)
![License](https://img.shields.io/badge/license-MIT-green)

> x402-gated Base token intelligence for AI trading agents.

## 1. What it is

`base-token-oracle` is a pay-per-call HTTP service that answers the single
question every Base trading agent asks before it buys: *is this token safe,
liquid, and real?* It exposes CoinGecko-style endpoints under
`/api/v1/x402/base/token/{address}/…`, each gated by
[x402 v2](https://docs.cdp.coinbase.com/x402/welcome) and settled in USDC on
Base mainnet. It is designed to be indexed by
[agentic.market](https://agentic.market) and called directly by `awal`,
`@x402/fetch`, or any x402-aware client.

## 2. Why

DexScreener, Honeypot.is, and Blockscout are each free on their own — but
integrating all three, normalizing their shapes, and reducing them to a single
decision-grade number is work that every agent developer currently redoes. This
service does that fusion once, deterministically, and charges per request. The
composite `/report` endpoint emits a `risk.score` (0–10) + `risk.flags[]`
computed by a rule-based engine (no LLM in the hot path), so output is
reproducible and cheap to trust.

## 3. Endpoints & prices

| Route | Price (USDC) | Source | Returns |
|---|---|---|---|
| `GET /healthz` | free | — | `{ ok: true }` |
| `GET /api/v1/x402/base/token/{address}/market` | **0.005** | DexScreener MCP | price, Δ24h, FDV, mcap, volume, liquidity, top pool |
| `GET /api/v1/x402/base/token/{address}/honeypot` | **0.01** | base-mcp-honeypot | `is_honeypot`, buy/sell/transfer tax, simulation result, reason |
| `GET /api/v1/x402/base/token/{address}/forensics` | **0.02** | dex-blockscout-mcp | deployer, verified, holder count, top-10 % concentration, deployer %, LP-lock heuristic (`?pair=0x…`) |
| `GET /api/v1/x402/base/token/{address}/report` | **0.03** | all three | composite + `risk.{score,level,flags}` + `generated_at` |

All paid routes settle in USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) on Base mainnet (chainId
**8453**).

## 4. Quick start for agents

Three equivalent ways to call the composite report for WETH on Base:

### a) `awal` CLI (easiest)

```bash
npx awal x402 pay \
  https://base-token-oracle.example.com/api/v1/x402/base/token/0x4200000000000000000000000000000000000006/report
```

`awal` discovers the 402 challenge, signs the USDC `transferWithAuthorization`
from your wallet, retries with `X-PAYMENT`, and prints the JSON response.

### b) Raw `curl` (two-step flow)

```bash
# 1. Unauthenticated request → 402 Payment Required with PaymentRequirements JSON.
curl -i https://base-token-oracle.example.com/api/v1/x402/base/token/0x4200000000000000000000000000000000000006/report

# 2. Sign a USDC transferWithAuthorization per x402 v2 spec, base64-encode, then:
curl https://base-token-oracle.example.com/api/v1/x402/base/token/0x4200000000000000000000000000000000000006/report \
  -H "X-PAYMENT: $(cat payment.b64)"
```

See [x402 v2 docs](https://docs.cdp.coinbase.com/x402/welcome) for generating
the `X-PAYMENT` header by hand. In practice, use a client SDK.

### c) `@x402/fetch` (TypeScript)

```ts
import { wrapFetchWithPayment } from '@x402/fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const wallet = createWalletClient({
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chain: base,
  transport: http(),
});

const pay = wrapFetchWithPayment(fetch, wallet);
const res = await pay(
  'https://base-token-oracle.example.com/api/v1/x402/base/token/0x4200000000000000000000000000000000000006/report',
);
console.log(await res.json());
```

## 5. Response schemas

Field names and null-handling are enforced by Zod schemas in
`src/routes/*.ts` — they are the source of truth.

### `/market`

```json
{
  "address": "0x4200000000000000000000000000000000000006",
  "chain": "base",
  "price_usd": 3412.55,
  "price_change_24h_pct": 1.42,
  "fdv": 41000000000,
  "market_cap": 41000000000,
  "volume_24h_usd": 12500000,
  "liquidity_usd": 8400000,
  "top_pool": {
    "pair_address": "0xd0b53d9277642d899df5c87a3966a349a798f224",
    "dex_id": "aerodrome",
    "base_token_symbol": "WETH",
    "quote_token_symbol": "USDC",
    "pair_created_at": "2023-08-16T02:04:00.000Z"
  },
  "pool_count": 37
}
```

### `/honeypot`

```json
{
  "address": "0x4200000000000000000000000000000000000006",
  "chain": "base",
  "is_honeypot": false,
  "buy_tax": 0,
  "sell_tax": 0,
  "transfer_tax": 0,
  "simulation_success": true,
  "honeypot_reason": null,
  "flags": []
}
```

Possible `flags`: `honeypot`, `simulation_failed`, `high_buy_tax`,
`high_sell_tax`.

### `/forensics`

```json
{
  "address": "0x4200000000000000000000000000000000000006",
  "chain": "base",
  "token": {
    "name": "Wrapped Ether",
    "symbol": "WETH",
    "decimals": 18,
    "total_supply": "140238472812345678901234",
    "type": "ERC-20",
    "verified": true
  },
  "deployer": {
    "address": "0x4200000000000000000000000000000000000000",
    "is_contract": true,
    "tx_count": 12
  },
  "holder_count": 312104,
  "top10_concentration_pct": 34.12,
  "deployer_holdings_pct": 0,
  "lp_locked_heuristic": null,
  "flags": []
}
```

`lp_locked_heuristic` is `null` unless the caller supplies `?pair=0x…`. When
supplied, it is `true` when a dead/zero address appears in the top-5 holders of
the LP token. Possible `flags`: `high_concentration`, `deployer_holds_large`,
`unverified_contract`, `lp_locked`.

### `/report`

```json
{
  "address": "0x4200000000000000000000000000000000000006",
  "chain": "base",
  "market":    { "...": "MarketResponse or { available: false, error: 'upstream_failure' }" },
  "honeypot":  { "...": "HoneypotResponse or { available: false, error: 'upstream_failure' }" },
  "forensics": { "...": "ForensicsResponse or { available: false, error: 'upstream_failure' }" },
  "risk": {
    "score": 0,
    "level": "clean",
    "flags": []
  },
  "generated_at": "2025-01-15T12:34:56.000Z"
}
```

If at least one section succeeds, `/report` returns **200** with a complete
risk score computed from the sections that resolved. If *all three* sections
fail, the endpoint returns **502** with `{ "error": "all_upstream_failed" }`.
Errored sections never poison the in-memory cache.

## 6. Risk engine

`src/risk/engine.ts` computes a deterministic 0–10 score. Every rule is
listed below; ignoring any undefined input.

| Δ Score | Flag | Condition |
|---|---|---|
| `+4` | `honeypot_detected` | `honeypot.is_honeypot === true` |
| `+2` | `high_tax` | `honeypot.buy_tax > 10` **or** `honeypot.sell_tax > 10` |
| `+2` | `high_concentration` | `forensics.top10_concentration_pct > 70` |
| `+1` | `deployer_holds_large` | `forensics.deployer_holdings_pct > 20` |
| `+1` | `low_liquidity` | `market.liquidity_usd < 10_000` |
| `+1` | `new_pair` | `market.pair_age_hours < 24` |
| `-1` | `lp_locked` | `forensics.lp_locked === true` |

Score is clamped to `[0, 10]`. Level mapping:

| Score | Level |
|---|---|
| 0–2 | `clean` |
| 3–5 | `caution` |
| 6–8 | `risky` |
| 9–10 | `critical` |

No LLM is involved — the same inputs always yield the same score. Agents can
cache decisions and reason about them symbolically.

## 7. Self-hosting

### Requirements

- Node 20+
- A Base mainnet wallet address to receive USDC payments
- An x402 facilitator URL (there is no universally canonical public
  mainnet facilitator; `FACILITATOR_URL` is **required** and will disable the
  paywall if unset)
- Commands to launch each upstream MCP over stdio

### `.env` walkthrough

Copy `.env.example` → `.env`:

```dotenv
PORT=8080

# x402 payment settings.
RECEIVING_ADDRESS=0xYourBaseAddressHere
# No canonical public mainnet facilitator — choose one (e.g. a self-hosted
# x402 facilitator, xpay, openx402, dexter, …). If unset, the server boots
# in free mode with a warning and /healthz reports { x402: false }.
FACILITATOR_URL=https://your-facilitator.example.com

# Per-route USDC prices. Keep in sync with public/openapi.yaml and public/llms.txt.
PRICE_MARKET=0.005
PRICE_HONEYPOT=0.01
PRICE_FORENSICS=0.02
PRICE_REPORT=0.03

# Stdio commands for upstream MCPs.
MCP_DEXSCREENER_CMD=node /path/to/dex-screener-mcp/dist/server.js
MCP_HONEYPOT_CMD=node /path/to/base-mcp-honeypot/dist/server.js
MCP_BLOCKSCOUT_CMD=node /path/to/dex-blockscout-mcp/dist/server.js

# In-memory cache TTL per (route,address).
CACHE_TTL_MS=45000
```

### Build & run

```bash
npm install
npm run build
npm start          # node dist/server.js
# or for development:
npm run dev        # tsx watch
```

### Docker

A production bundle ships in this repo:

- `Dockerfile` — multi-stage image containing the oracle plus prebuilt
  `dist/` of all three upstream MCPs (`dex-screener-mcp`,
  `base-mcp-honeypot`, `dex-blockscout-mcp`). They run as stdio children of
  the oracle process — no extra containers.
- `docker-compose.prod.yml` — oracle + Caddy (auto-TLS).
- `Caddyfile` — reverse-proxy / TLS terminator.

See **Production Deployment** below for operator instructions.

## 8. Production Deployment

### Parent-directory layout

The Docker build needs source for all four sibling repos, because the MCP
projects live outside this repo. Lay them out as siblings under one parent
dir (the build context is `..`):

```
<parent>/
├── base-token-oracle/      # this repo
├── dex-screener-mcp/
├── base-mcp-honeypot/
└── dex-blockscout-mcp/
```

### One-time config

```bash
cd <parent>/base-token-oracle
cp .env.example .env
# edit .env and set at minimum:
#   RECEIVING_ADDRESS=0xYourBaseAddress
#   FACILITATOR_URL=https://your-facilitator.example.com
# PRICE_* + CACHE_TTL_MS are optional overrides.
# Do NOT set MCP_*_CMD — the image presets those to /app/mcps/<name>/dist/*.js.
```

### Bring the stack up

Run from the **parent** directory (so `context: ..` resolves correctly):

```bash
cd <parent>
DOMAIN=base-oracle.example.com \
  docker compose -f base-token-oracle/docker-compose.prod.yml up -d --build
```

`DOMAIN` is consumed by the Caddyfile and triggers auto-TLS via Let's Encrypt.
Make sure the domain's A/AAAA record already points at the host and ports 80
and 443 are reachable.

### Logs

```bash
docker compose -f base-token-oracle/docker-compose.prod.yml logs -f oracle
docker compose -f base-token-oracle/docker-compose.prod.yml logs -f caddy
```

### Smoke test

Unauthenticated probes (no wallet required):

```bash
curl https://base-oracle.example.com/healthz
curl https://base-oracle.example.com/llms.txt
# local, against a service on :8080 — runs /healthz, /llms.txt, and a 402 check:
ORACLE_URL=https://base-oracle.example.com npm run smoke
```

The **real paid call** exercising the full x402 flow (sign →
`X-PAYMENT` → `200`) is a manual post-deploy step because it requires a
funded Base-mainnet wallet and incurs real USDC cost (≈ $0.005):

```bash
awal x402 pay GET \
  https://base-oracle.example.com/api/v1/x402/base/token/0x4200000000000000000000000000000000000006/market
```

This cannot be automated in CI — on-chain funds can't safely live in a CI
runner — so every first deploy (and every facilitator change) should be
hand-verified by an operator exactly once.

## 9. Architecture

```
┌──────────────────────────────────────────────┐
│  Agent (awal / @x402/fetch / custom)         │
│  GET /api/v1/x402/base/token/0x…/report      │
└──────────────────┬───────────────────────────┘
                   │ 402 → pay USDC on Base → retry with X-PAYMENT
                   ▼
┌──────────────────────────────────────────────┐
│  Express + @x402/express paymentMiddleware   │
│  (facilitator: x402.org/facilitator or own)  │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│  Orchestrator (TokenOracle service)          │
│   • Parallel fan-out to 3 MCP clients        │
│   • Normalizes + scores → RiskEngine         │
│   • 30–60s in-memory cache per (addr, route) │
└──┬───────────────┬──────────────────┬────────┘
   ▼               ▼                  ▼
dex-screener   base-mcp-          dex-blockscout
   -mcp         honeypot              -mcp
 (stdio)        (stdio)              (stdio)
```

## 10. MCP servers used

All three are stdio subprocesses managed by
`src/mcp/client.ts`. They are pure data sources — `base-token-oracle` does the
normalization, scoring, and x402 gating.

| MCP | Role | Source |
|---|---|---|
| `dex-screener-mcp` | Market layer (price, liquidity, volume, pool list) | [`dchu3/dex-screener-mcp`](https://github.com/dchu3/dex-screener-mcp) |
| `base-mcp-honeypot` | Trap detection (Honeypot.is) | [`dchu3/base-mcp-honeypot`](https://github.com/dchu3/base-mcp-honeypot) |
| `dex-blockscout-mcp` | On-chain forensics (Base Blockscout v2) | [`dchu3/dex-blockscout-mcp`](https://github.com/dchu3/dex-blockscout-mcp) |

## 11. License

MIT.
