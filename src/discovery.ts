import { declareDiscoveryExtension } from '@x402/extensions';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { MarketResponseSchema } from './services/market.js';
import { NormalizedHoneypotSchema } from './services/honeypot.js';
import { ForensicsResponseSchema } from './services/forensics.js';
import { ReportResponseSchema } from './routes/report.js';
import { BASE_PATH } from './payments.js';

/**
 * Public Base mainnet token used purely as a static example payload in
 * Bazaar discovery metadata. WETH is a well-known public contract; using
 * it here ensures we never embed an operator-controlled address in
 * source-controlled examples.
 */
const SAMPLE_ADDRESS = '0x4200000000000000000000000000000000000006';

function jsonSchema(schema: ZodTypeAny, _name: string): Record<string, unknown> {
  // Fully inline JSON Schema (no $defs / $ref) so Bazaar's strict validator
  // can resolve the schema standalone. Without `$refStrategy: 'none'`,
  // shared subschemas (e.g. MarketResponseSchema referenced from
  // ReportResponseSchema) are emitted as `$ref` pointers that the
  // facilitator's Ajv instance can't follow.
  return zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

const marketExample = {
  address: SAMPLE_ADDRESS,
  chain: 'base' as const,
  price_usd: 3450.12,
  price_change_24h_pct: 1.42,
  fdv: 8_500_000_000,
  market_cap: 8_500_000_000,
  volume_24h_usd: 12_300_000,
  liquidity_usd: 4_750_000,
  top_pool: {
    pair_address: '0xd0b53d9277642d899df5c87a3966a349a798f224',
    dex_id: 'aerodrome',
    base_token_symbol: 'WETH',
    quote_token_symbol: 'USDC',
    pair_created_at: '2023-08-09T00:00:00.000Z',
  },
  pool_count: 42,
};

const honeypotExample = {
  address: SAMPLE_ADDRESS,
  chain: 'base' as const,
  is_honeypot: false,
  buy_tax: 0,
  sell_tax: 0,
  transfer_tax: 0,
  simulation_success: true,
  honeypot_reason: null,
  flags: [],
};

const forensicsExample = {
  address: SAMPLE_ADDRESS,
  chain: 'base' as const,
  token: {
    name: 'Wrapped Ether',
    symbol: 'WETH',
    decimals: 18,
    total_supply: '2400000000000000000000',
    type: 'ERC-20',
    verified: true,
  },
  deployer: {
    address: '0x0000000000000000000000000000000000000000',
    is_contract: false,
    tx_count: 1,
  },
  holder_count: 198_000,
  top10_concentration_pct: 41.2,
  deployer_holdings_pct: 0,
  lp_locked_heuristic: true,
  flags: [],
};

const reportExample = {
  address: SAMPLE_ADDRESS,
  chain: 'base' as const,
  market: marketExample,
  honeypot: honeypotExample,
  forensics: forensicsExample,
  risk: {
    score: 1,
    level: 'clean' as const,
    flags: ['lp_locked'],
  },
  generated_at: '2025-01-01T00:00:00.000Z',
};

const marketDescription =
  'Real-time market snapshot for any Base ERC-20 token. Returns top DexScreener ' +
  'pool, USD price, 24h price change, FDV, market cap, 24h volume, USD liquidity, ' +
  'and pool count. Address is supplied via the `:address` path parameter ' +
  '(0x-prefixed Base mainnet ERC-20). Pay-per-call via x402 / USDC on Base.';

const honeypotDescription =
  'Honeypot.is buy/sell simulation for a Base ERC-20. Returns is_honeypot verdict, ' +
  'buy/sell/transfer tax percentages, simulation success flag, and a free-form ' +
  'reason string when a honeypot is detected. Use to detect malicious tax/' +
  'transfer-restriction tokens before trading. Address is supplied via the ' +
  '`:address` path parameter. Pay-per-call via x402 / USDC on Base.';

const forensicsDescription =
  'On-chain forensics for a Base ERC-20 sourced from Blockscout: token metadata ' +
  '(name, symbol, decimals, total supply, verified status), deployer profile, ' +
  'holder count, top-10 holder concentration, deployer holdings, and an LP-lock ' +
  'heuristic. Address is supplied via the `:address` path parameter. ' +
  'Pay-per-call via x402 / USDC on Base.';

const reportDescription =
  'Composite token-safety report for any Base ERC-20. Aggregates DexScreener ' +
  'market data, Honeypot.is simulation, and Blockscout on-chain forensics into ' +
  'a deterministic 0–10 risk score with one of four levels (clean, caution, ' +
  'risky, critical) and a list of triggered flags. Designed for AI agents that ' +
  'need a single structured trust signal before interacting with a token. ' +
  'Address is supplied via the `:address` path parameter. ' +
  'Pay-per-call via x402 / USDC on Base.';

function buildExtensions(): Record<
  'market' | 'honeypot' | 'forensics' | 'report',
  Record<string, unknown>
> {
  return {
    market: declareDiscoveryExtension({
      description: marketDescription,
      output: {
        example: marketExample,
        schema: jsonSchema(MarketResponseSchema, 'MarketResponse'),
      },
    }),
    honeypot: declareDiscoveryExtension({
      description: honeypotDescription,
      output: {
        example: honeypotExample,
        schema: jsonSchema(NormalizedHoneypotSchema, 'NormalizedHoneypot'),
      },
    }),
    forensics: declareDiscoveryExtension({
      description: forensicsDescription,
      output: {
        example: forensicsExample,
        schema: jsonSchema(ForensicsResponseSchema, 'ForensicsResponse'),
      },
    }),
    report: declareDiscoveryExtension({
      description: reportDescription,
      output: {
        example: reportExample,
        schema: jsonSchema(ReportResponseSchema, 'ReportResponse'),
      },
    }),
  };
}

export type DiscoveryRouteKey = `GET ${string}`;

/**
 * Build the per-route Bazaar discovery extension declarations keyed by the
 * same `"GET <path>"` strings that `payments.ts#buildRoutes` uses for the
 * x402 route config. Attached to `RouteConfig.extensions` so the CDP
 * facilitator can index our resources after the first successful settlement.
 */
export function buildDiscoveryExtensions(): Record<DiscoveryRouteKey, Record<string, unknown>> {
  const exts = buildExtensions();
  return {
    [`GET ${BASE_PATH}/token/:address/market`]: exts.market,
    [`GET ${BASE_PATH}/token/:address/honeypot`]: exts.honeypot,
    [`GET ${BASE_PATH}/token/:address/forensics`]: exts.forensics,
    [`GET ${BASE_PATH}/token/:address/report`]: exts.report,
  };
}
