# base-token-oracle

![Node](https://img.shields.io/badge/node-20.x-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)
![x402](https://img.shields.io/badge/x402-v2-black)
![License](https://img.shields.io/badge/license-MIT-green)

> x402-gated Base token forensics for AI trading agents.

## 1. What it is

`base-token-oracle` is a pay-per-call HTTP service that provides deep on-chain
forensics for Base tokens. It answers the question every trading agent asks
before buying: *is this token real, verified, and safe?* 

Exposes a single `/api/v1/x402/base/token/{address}/report` endpoint, gated by
[x402 v2](https://docs.cdp.coinbase.com/x402/welcome) and settled in USDC on
Base mainnet. 

## 2. Why

Normalizing Blockscout forensics, computing holder concentration, and 
identifying LP-locks is repetitive work. This service provides a clean, 
deterministic, and structured report for any Base ERC-20 token, purpose-built 
for autonomous agents that need machine-readable trust signals.

## 3. Endpoints & prices

| Route | Price (USDC) | Source | Returns |
|---|---|---|---|
| `GET /healthz` | free | — | `{ ok: true }` |
| `GET /api/v1/x402/base/token/{address}/report` | **0.01** | Blockscout MCP | financials, deployer (balance, creation, activity), token activity, verified status, holder count, top-10 concentration, LP-lock heuristic |

All paid routes settle in USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) on Base mainnet (chainId
**8453**).

## 4. Quick start for agents

### `awal` CLI

```bash
npx awal x402 pay \
  https://base-token-oracle.example.com/api/v1/x402/base/token/0x4200000000000000000000000000000000000006/report
```

`awal` discovers the 402 challenge, signs the USDC `transferWithAuthorization`
from your wallet, retries with `X-PAYMENT`, and prints the JSON response.

## 5. Response schema

### `/report`

```json
{
  "address": "0x4200000000000000000000000000000000000006",
  "chain": "base",
  "token": {
    "name": "Wrapped Ether",
    "symbol": "WETH",
    "decimals": 18,
    "total_supply": "140238472812345678901234",
    "circulating_market_cap": "1000000000",
    "exchange_rate": "2500.50",
    "type": "ERC-20",
    "verified": true
  },
  "deployer": {
    "address": "0x4200000000000000000000000000000000000000",
    "is_contract": true,
    "tx_count": 12,
    "coin_balance": "1000000000000000000",
    "creation_tx_hash": "0xabc123...",
    "last_active_timestamp": "2026-04-29T12:00:00Z"
  },
  "token_activity": {
    "last_active_timestamp": "2026-04-29T12:15:00Z",
    "recent_methods": ["transfer", "approve"]
  },
  "holder_count": 312104,
  "top10_concentration_pct": 34.12,
  "circulating_top10_concentration_pct": 28.4,
  "top_holders": [
    {
      "address": "0x4200000000000000000000000000000000000010",
      "value": "12000000000000000000000",
      "percent": 12.0,
      "category": "bridge"
    }
  ],
  "deployer_holdings_pct": 0,
  "lp_locked_heuristic": null,
  "flags": []
}
```

`lp_locked_heuristic` is `null` unless the caller supplies `?pair=0x…`. When
supplied, it is `true` when a dead/zero address appears in the top-5 holders of
the LP token.

### Flags

The `flags` array contains descriptive attribute tags derived directly from
the Blockscout-sourced fields above. They are not weighted, scored, or
aggregated into a level — consumers decide what (if anything) each flag
means for their use case.

| Flag | Trigger |
|---|---|
| `high_concentration` | `circulating_top10_concentration_pct > 70` (falls back to `top10_concentration_pct` when the adjusted value can't be computed) |
| `deployer_holds_large` | `deployer_holdings_pct > 20` |
| `unverified_contract` | `token.verified === false` |
| `lp_locked` | dead/burn address in top-5 LP holders (requires `?pair=`) |

A flag is omitted whenever its source field is `null` (e.g., `lp_locked` is
only emitted when `?pair=` is supplied and the heuristic returns `true`).

### Top-holder categories

`top_holders[].category` annotates each of the (up-to) ten largest holders so
consumers can tell raw concentration apart from circulating-supply
concentration:

| Category | Meaning |
|---|---|
| `burn` | Known dead/burn sink (`0x0…0`, `0x…dead`). Excluded from circulating. |
| `bridge` | Canonical Base bridge or major cross-chain messaging contract. Excluded from circulating. |
| `deployer` | Matches `deployer.address`. |
| `contract` | Any other contract — LP pools, vaults, multisigs, routers. Counted as circulating. |
| `eoa` | Externally-owned account. |
| `unknown` | Blockscout lookup failed; no `is_contract` signal. |

`circulating_top10_concentration_pct` divides the top-10 sum (excluding
burn + bridge) by `total_supply − burn − bridge`, so a token whose float
sits in a Uniswap pool or the Base canonical bridge isn't misflagged as
"high concentration" purely due to non-recoverable or non-circulating
balances.

## 6. Self-hosting

### Requirements

- Node 20+
- A Base mainnet wallet address to receive USDC payments
- An x402 facilitator URL (`FACILITATOR_URL`)
- Blockscout MCP launch command

### `.env`

```dotenv
PORT=8080
RECEIVING_ADDRESS=0xYourBaseAddressHere
FACILITATOR_URL=https://your-facilitator.example.com
PRICE_REPORT=0.01
MCP_BLOCKSCOUT_CMD=node /path/to/dex-blockscout-mcp/dist/server.js
CACHE_TTL_MS=45000
```

### TLS / Let's Encrypt rate limits

The `docker-compose.prod.yml` Caddy service obtains certificates via ACME and
persists ACME account keys plus issued certs in the **`caddy_data`** named
volume. Two pitfalls to avoid:

1. **Don't run `docker compose down -v`** unless you intend to throw the
   certs away. Each fresh issuance counts against Let's Encrypt's
   "5 duplicate certificates per exact identifier set per 168 h"
   [rate limit](https://letsencrypt.org/docs/rate-limits/), and once you
   trip it you're locked out for up to 7 days.

2. **If you've already hit the limit**, set `ACME_CA` in your env to switch
   issuers without waiting:

   ```dotenv
   # LE staging — UNTRUSTED by browsers/clients. Use only to confirm Caddy
   # is otherwise healthy. Production traffic will see cert errors.
   ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory
   ```

   For a publicly-trusted alternative use Caddy's built-in **ZeroSSL**
   issuer instead of `acme_ca` — ZeroSSL via plain ACME requires External
   Account Binding (EAB) credentials, which Caddy's `zerossl` module
   provisions automatically. This isn't wired through `ACME_CA` (the
   directory URL alone won't work without EAB); add a `tls` block to the
   site in the `Caddyfile` if needed. See
   [Caddy ZeroSSL docs](https://caddyserver.com/docs/automatic-https#zerossl).

   Once the LE rate-limit window expires, **unset `ACME_CA`** (or set it
   back to `https://acme-v02.api.letsencrypt.org/directory`) and restart
   Caddy to resume issuing publicly-trusted Let's Encrypt certs.

## 7. Architecture

```
┌──────────────────────────────────────────────┐
│  Agent (awal / @x402/fetch / custom)         │
│  GET /api/v1/x402/base/token/0x…/report      │
└──────────────────┬───────────────────────────┘
                   │ 402 → pay USDC on Base
                   ▼
┌──────────────────────────────────────────────┐
│  Express + @x402/express paymentMiddleware   │
└──────────────────┬───────────────────────────┘
                   ▼
┌──────────────────────────────────────────────┐
│  Orchestrator (src/routes/report.ts)         │
│   • Fetches from Blockscout MCP              │
│   • Normalizes into Forensics schema         │
└──┬───────────────────────────────────────────┘
   ▼
dex-blockscout-mcp (stdio)
```

## 8. License

MIT.
