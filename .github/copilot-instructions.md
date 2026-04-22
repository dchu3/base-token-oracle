# Copilot Instructions for base-token-oracle

## Build, Test, and Lint Commands

**Build:**
```bash
npm run build          # Compile TypeScript to dist/
```

**Development:**
```bash
npm run dev            # Watch mode with tsx — recompiles on changes
```

**Start the server:**
```bash
npm start              # node --env-file-if-exists=.env dist/server.js (port default 8080)
```

**Testing:**
```bash
npm test               # Run all vitest tests (tests/**/*.test.ts)
npm test -- <pattern> # Run specific test file, e.g., npm test -- risk/engine.test.ts
npm test -- --watch   # Watch mode for test development
```

**Linting:**
```bash
npm run lint           # Check src/**/*.ts and tests/**/*.ts with eslint
```

**Smoke test (production):**
```bash
ORACLE_URL=https://example.com npm run smoke  # Runs /healthz, /llms.txt, and 402 check
```

## High-Level Architecture

**Purpose:** x402-gated HTTP service that aggregates token safety intelligence from three upstream MCPs (DexScreener, Honeypot.is, Blockscout) into a composite risk score.

**Request Flow:**
1. Agent calls `GET /api/v1/x402/base/token/{address}/report` (or other endpoint)
2. x402 paymentMiddleware intercepts → returns 402 if no payment header
3. Agent signs USDC `transferWithAuthorization` on Base mainnet, retries with `X-PAYMENT` header
4. Facilitator validates payment signature
5. Orchestrator (`TokenOracle` service) fan-outs to 3 MCP clients in parallel
6. Results are normalized, scored by deterministic RiskEngine, cached, and returned

**Core Layers:**

| Layer | Location | Responsibility |
|-------|----------|---|
| **Entrypoint** | `src/server.ts` | Express app setup, route registration, MCP/cache initialization from env |
| **Routes** | `src/routes/*.ts` | HTTP handlers with Zod schema validation; call services and return typed responses |
| **Services** | `src/services/*.ts` | Normalize upstream responses into canonical schemas (`MarketResponse`, `NormalizedHoneypot`, `ForensicsResponse`) |
| **MCP Client** | `src/mcp/client.ts` | Spawn and manage stdio subprocesses; each MCP is a `McpClient` instance |
| **MCP Handlers** | `src/mcp/{dexScreener,honeypot,blockscout}.ts` | Tool call handlers — parse raw MCP responses and map to internal types |
| **Risk Engine** | `src/risk/engine.ts` | Deterministic rule-based scoring (no LLM); always same input → same score |
| **Cache** | `src/cache.ts` | TTL-based LRU cache per (route, address) pair |
| **Payments** | `src/payments.ts` | x402 v2 middleware; RECEIVING_ADDRESS and FACILITATOR_URL from env |

## Key Conventions

### Zod Schemas as Source of Truth
- Response schemas live in `src/routes/*.ts` and `src/services/*.ts`
- All field names, types, and null-handling are enforced by Zod
- Schemas define API contracts — they are the source of truth for documentation
- Example: `ReportResponseSchema` in `src/routes/report.ts`

### Environment Configuration
- All runtime config comes from `.env` (copy from `.env.example`)
- Key variables:
  - `PORT` (default 8080)
  - `RECEIVING_ADDRESS` (Base wallet address, required for payments)
  - `FACILITATOR_URL` (x402 facilitator, required for payments)
  - `PRICE_*` (per-route USDC prices)
  - `MCP_*_CMD` (stdio commands for upstream MCPs)
  - `CACHE_TTL_MS` (default 45000ms)
- Missing RECEIVING_ADDRESS or FACILITATOR_URL boots in free mode (warning in logs, `x402: false` in `/healthz`)

### Service Pattern
- Each `src/services/*.ts` file exports:
  - A `FetchFunction` (e.g., `fetchMarketSummary`) that calls MCP and normalizes
  - A `cachedFetchFunction` (e.g., `cachedFetchMarketSummary`) that wraps the fetch with cache
  - TypeScript types for the normalized response (e.g., `MarketResponse`)
  - Zod schema for validation (e.g., `MarketResponseSchema`)
- Services are composable — `src/routes/report.ts` calls all three cached fetchers in parallel

### Risk Engine Rules
Deterministic score (clamped to 0–10):
- `+4` if honeypot detected
- `+2` if buy/sell tax > 10%
- `+2` if top-10 holder concentration > 70%
- `+1` if deployer holds > 20%
- `+1` if liquidity < $10k
- `+1` if pair < 24 hours old
- `-1` if LP is locked (reduces risk)

Level mapping: `0–2` = clean, `3–5` = caution, `6–8` = risky, `9–10` = critical. See `src/risk/engine.ts` for implementation.

### MCP Client Management
- All MCPs are stdio subprocesses spawned once at startup
- Managed by `McpManager` singleton created in `src/mcp/index.ts`
- Each MCP (`dexScreener`, `honeypot`, `blockscout`) is optional — routes only register if MCP is available
- Tool call handlers return typed results that are then passed to services for normalization
- Errors in one MCP don't poison cache or break other requests — `/report` computes risk from sections that succeeded

### Parallel Request Handling
- Routes use `Promise.all()` to fan-out to multiple services where applicable
- Each (address, route) pair is cached independently
- Cache TTL is per-pair — stale data for one address doesn't affect another

### Testing Pattern
- Test files live in `tests/**/*.test.ts` and mirror the src structure
- Use vitest (included in package.json)
- Routes are tested via `supertest` (Express handler testing)
- Mock MCPs and services in route tests to avoid subprocess complexity
- Example: `tests/routes/report.test.ts` mocks the three services and tests the endpoint

### Code Style
- Strict TypeScript (`"strict": true` in tsconfig.json)
- ESLint enforces `@typescript-eslint/no-explicit-any` and unused variable warnings (args prefixed with `_` are ignored)
- Prettier formatting (100-char line width, trailing commas, semicolons)
- Node 20+ target (ES2022)

## Production Deployment Notes

**Docker:**
- Multi-stage Dockerfile bundles the oracle + prebuilt dist of all three upstream MCPs
- MCPs run as stdio children of the oracle process (no extra containers)
- See Caddyfile for reverse-proxy and auto-TLS via Let's Encrypt

**Parent Directory Layout:**
For docker build to resolve sibling MCP repos, layout must be:
```
<parent>/
├── base-token-oracle/      # this repo
├── dex-screener-mcp/
├── dex-honeypot-mcp/
└── dex-blockscout-mcp/
```
Build from the parent directory with `context: ..`.

**Smoke Testing:**
- Free endpoint test: `curl /healthz` and `curl /llms.txt`
- Paid endpoint test (requires funded Base wallet): `awal x402 pay GET <endpoint>` — cannot be automated in CI

## Coinbase CDP x402 Facilitator (Optional)

The oracle supports Coinbase's CDP facilitator as an alternative to generic HTTP facilitators for handling x402 payment validation and USDC transfers. This provides a streamlined integration with Coinbase's Developer Platform if you're already using CDP for wallet or token management.

**Getting API Keys:**
- Create a Coinbase Developer Platform account at [developer.coinbase.com](https://developer.coinbase.com)
- Navigate to the API Keys section and create a new API key
- You'll receive both a key ID and an API key secret — treat the secret as a password (store in `.env`, not in version control)
- See [Coinbase CDP v2 Authentication](https://docs.cdp.coinbase.com/api-reference/v2/authentication) for details

**Environment Setup:**

Set these variables in `.env` to enable CDP facilitator:
- `FACILITATOR_URL`: Must be set to `https://api.cdp.coinbase.com/platform/v2/x402`
- `CDP_API_KEY_ID`: Your Coinbase CDP API key ID
- `CDP_API_KEY_PRIVATE_KEY` (or `CDP_API_KEY_SECRET`): Your Ed25519 API key secret. Accepts either a PEM-encoded private key or the libsodium base64 format (seed‖pub) emitted by the CDP portal.

**Behavior:**
- If both `CDP_API_KEY_ID` and a key secret are set, the oracle uses `CdpFacilitatorClient` for payment validation
- If these are not set, the oracle falls back to the generic `HTTPFacilitatorClient` (which sends no auth)
- Authentication uses a short-lived (≤120s) Ed25519 JWT (`alg: EdDSA`) sent as `Authorization: Bearer …`, per the CDP v2 spec (claims: `iss=cdp`, `sub=keyId`, `aud=["cdp_service"]`, `nbf`, `exp`, `uri="METHOD host/path"`, random `nonce` in the header)

**Example .env Configuration:**
```
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=your-api-key-id-here
CDP_API_KEY_PRIVATE_KEY=your-api-key-secret-here
RECEIVING_ADDRESS=0x...  # Your Base mainnet address
PORT=8080
```

## File Organization Summary

```
src/
├── server.ts                # App factory & main entry point
├── payments.ts              # x402 v2 middleware
├── cache.ts                 # TTL-LRU cache
├── routes/                  # HTTP handlers (market, honeypot, forensics, report)
├── services/                # Normalization + caching (market, honeypot, forensics)
├── mcp/
│   ├── index.ts             # McpManager singleton factory
│   ├── client.ts            # Generic MCP stdio client
│   ├── dexScreener.ts       # DexScreener tool handlers
│   ├── honeypot.ts          # Honeypot.is tool handlers
│   ├── blockscout.ts        # Blockscout tool handlers
│   └── shared.ts            # MCP type definitions
└── risk/
    └── engine.ts            # Deterministic risk scoring
```
