import { declareDiscoveryExtension, BAZAAR } from '@x402/extensions';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { ForensicsResponseSchema } from './services/forensics.js';
import { BASE_PATH } from './payments.js';

/**
 * Public Base mainnet token used purely as a static example payload in
 * Bazaar discovery metadata. WETH is a well-known public contract; using
 * it here ensures we never embed an operator-controlled address in
 * source-controlled examples.
 */
const SAMPLE_ADDRESS = '0x4200000000000000000000000000000000000006';

function jsonSchema(schema: ZodTypeAny, _name: string): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  const { $schema: _meta, $id: _id, ...body } = raw;
  return body;
}

const reportExample = {
  address: SAMPLE_ADDRESS,
  chain: 'base' as const,
  token: {
    name: 'Wrapped Ether',
    symbol: 'WETH',
    decimals: 18,
    total_supply: '2400000000000000000000',
    circulating_market_cap: '1000000000',
    exchange_rate: '2500.50',
    type: 'ERC-20',
    verified: true,
  },
  deployer: {
    address: '0x0000000000000000000000000000000000000000',
    is_contract: false,
    tx_count: 1,
    coin_balance: '1000000000000000000',
    creation_tx_hash: '0xabc123...',
    last_active_timestamp: '2026-04-29T12:00:00Z',
  },
  token_activity: {
    last_active_timestamp: '2026-04-29T12:15:00Z',
    recent_methods: ['transfer', 'approve'],
  },
  holder_count: 198_000,
  top10_concentration_pct: 41.2,
  deployer_holdings_pct: 0,
  lp_locked_heuristic: true,
  flags: [],
};

export const reportDescription =
  'On-chain forensics for a Base ERC-20 sourced from Blockscout: ' +
  'token metadata (name, symbol, decimals, total supply, financials, verified status), ' +
  'deployer profile (balance, creation, activity), token activity metrics, holder count, ' +
  'top-10 holder concentration, deployer holdings, an LP-lock heuristic, and ' +
  'descriptive attribute flags. ' +
  'Address is supplied via the `:address` path parameter. Pay-per-call via x402 / USDC on Base.';

/**
 * Wrapper around `declareDiscoveryExtension` that pre-injects the HTTP
 * method into the resulting Bazaar envelope.
 */
function declareGetExtension(
  config: Parameters<typeof declareDiscoveryExtension>[0],
): Record<string, unknown> {
  const envelope = declareDiscoveryExtension(config) as Record<string, unknown>;
  const bazaar = envelope[BAZAAR.key] as {
    info: { input: Record<string, unknown> & { method?: string } };
    schema: {
      properties: {
        input: {
          properties: Record<string, unknown>;
          required?: string[];
        };
      };
    };
  };
  bazaar.info.input.method = 'GET';
  (bazaar as Record<string, unknown>).discoverable = true;
  (bazaar as Record<string, unknown>).category = 'web3';
  (bazaar as Record<string, unknown>).tags = ['base', 'erc20', 'forensics'];
  bazaar.schema.properties.input.properties.method = {
    type: 'string',
    enum: ['GET'],
  };
  const required = bazaar.schema.properties.input.required ?? [];
  if (!required.includes('method')) {
    bazaar.schema.properties.input.required = [...required, 'method'];
  }
  return envelope;
}

function buildExtensions(): Record<'report', Record<string, unknown>> {
  return {
    report: declareGetExtension({
      description: reportDescription,
      output: {
        example: reportExample,
        schema: jsonSchema(ForensicsResponseSchema, 'ReportResponse'),
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
    [`GET ${BASE_PATH}/token/:address/report`]: exts.report,
  };
}
