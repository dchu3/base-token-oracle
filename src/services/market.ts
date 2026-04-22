import { z } from 'zod';
import type { DexScreenerPair, DexScreenerService } from '../mcp/dexScreener.js';
import type { TtlLruCache } from '../cache.js';

const TopPoolSchema = z.object({
  pair_address: z.string().nullable(),
  dex_id: z.string().nullable(),
  base_token_symbol: z.string().nullable(),
  quote_token_symbol: z.string().nullable(),
  pair_created_at: z.string().nullable(),
});

export const MarketResponseSchema = z.object({
  address: z.string(),
  chain: z.literal('base'),
  price_usd: z.number().nullable(),
  price_change_24h_pct: z.number().nullable(),
  fdv: z.number().nullable(),
  market_cap: z.number().nullable(),
  volume_24h_usd: z.number().nullable(),
  liquidity_usd: z.number().nullable(),
  top_pool: TopPoolSchema,
  pool_count: z.number().int().nonnegative(),
});

export type MarketResponse = z.infer<typeof MarketResponseSchema>;

export type DexScreenerLike = Pick<DexScreenerService, 'getTokenPools'>;

export type MarketErrorCode = 'no_dexscreener' | 'no_pools_found' | 'upstream_failure';

export class MarketError extends Error {
  readonly code: MarketErrorCode;
  constructor(code: MarketErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'MarketError';
  }
}

function pickTopPool(pools: DexScreenerPair[]): DexScreenerPair | null {
  let best: DexScreenerPair | null = null;
  let bestLiq = -Infinity;
  for (const pool of pools) {
    const liq = pool.liquidity?.usd ?? -Infinity;
    if (liq > bestLiq) {
      bestLiq = liq;
      best = pool;
    }
  }
  return best ?? pools[0] ?? null;
}

function parseNumeric(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function buildResponse(address: string, pools: DexScreenerPair[]): MarketResponse {
  const top = pickTopPool(pools);
  if (!top) {
    throw new MarketError('no_pools_found');
  }

  const priceChange24h =
    top.priceChange && typeof top.priceChange.h24 === 'number' ? top.priceChange.h24 : null;
  const volume24h = top.volume && typeof top.volume.h24 === 'number' ? top.volume.h24 : null;

  const payload: MarketResponse = {
    address,
    chain: 'base',
    price_usd: parseNumeric(top.priceUsd),
    price_change_24h_pct: priceChange24h,
    fdv: typeof top.fdv === 'number' ? top.fdv : null,
    market_cap: typeof top.marketCap === 'number' ? top.marketCap : null,
    volume_24h_usd: volume24h,
    liquidity_usd: typeof top.liquidity?.usd === 'number' ? top.liquidity.usd : null,
    top_pool: {
      pair_address: top.pairAddress ?? null,
      dex_id: top.dexId ?? null,
      base_token_symbol: top.baseToken?.symbol ?? null,
      quote_token_symbol: top.quoteToken?.symbol ?? null,
      pair_created_at: toIsoDate(top.pairCreatedAt),
    },
    pool_count: pools.length,
  };

  return MarketResponseSchema.parse(payload);
}

/**
 * Fetch + normalize DexScreener market data for a single address.
 *
 * Throws `MarketError` with a discriminator `code`:
 *  - `'no_dexscreener'`  — DI missing (upstream never configured)
 *  - `'no_pools_found'`  — 0 pools returned (treat as 404)
 *  - `'upstream_failure'` — MCP threw / any other failure
 */
export async function fetchMarketSummary(
  dexScreener: DexScreenerLike | null,
  address: string,
): Promise<MarketResponse> {
  if (!dexScreener) {
    throw new MarketError('no_dexscreener');
  }
  let pools: DexScreenerPair[];
  try {
    pools = await dexScreener.getTokenPools('base', address);
  } catch (err) {
    throw new MarketError('upstream_failure', err instanceof Error ? err.message : undefined);
  }
  if (pools.length === 0) {
    throw new MarketError('no_pools_found');
  }
  return buildResponse(address, pools);
}

export function marketCacheKey(address: string): string {
  return `market:${address}`;
}

export async function cachedFetchMarketSummary(
  dexScreener: DexScreenerLike | null,
  address: string,
  cache: TtlLruCache<unknown> | null,
): Promise<MarketResponse> {
  if (!cache) return fetchMarketSummary(dexScreener, address);
  const key = marketCacheKey(address);
  const hit = cache.get(key) as MarketResponse | undefined;
  if (hit !== undefined) return hit;
  const value = await fetchMarketSummary(dexScreener, address);
  cache.set(key, value);
  return value;
}
