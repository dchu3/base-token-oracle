import { z } from 'zod';
import type {
  BlockscoutAddress,
  BlockscoutAddressTxs,
  BlockscoutChain,
  BlockscoutHolders,
  BlockscoutToken,
} from '../mcp/blockscout.js';
import type { TtlLruCache } from '../cache.js';
import { computeFlags, FlagSchema } from './flags.js';
import {
  HOLDER_CATEGORIES,
  NON_CIRCULATING_CATEGORIES,
  classifyHolder,
  type HolderCategory,
} from './holderTags.js';

export interface ForensicsBlockscout {
  getToken(addressHash: string, chain?: BlockscoutChain): Promise<BlockscoutToken>;
  getTokenHolders(addressHash: string, chain?: BlockscoutChain): Promise<BlockscoutHolders>;
  getAddress(addressHash: string, chain?: BlockscoutChain): Promise<BlockscoutAddress>;
  getAddressTransactions(
    addressHash: string,
    chain?: BlockscoutChain,
  ): Promise<BlockscoutAddressTxs>;
}

const TokenOutSchema = z.object({
  name: z.string().nullable(),
  symbol: z.string().nullable(),
  decimals: z.number().int().nonnegative().nullable(),
  total_supply: z.string().nullable(),
  circulating_market_cap: z.string().nullable(),
  exchange_rate: z.string().nullable(),
  type: z.string().nullable(),
  verified: z.boolean().nullable(),
});

const DeployerOutSchema = z
  .object({
    address: z.string(),
    is_contract: z.boolean().nullable(),
    tx_count: z.number().int().nonnegative().nullable(),
    coin_balance: z.string().nullable(),
    creation_tx_hash: z.string().nullable(),
    last_active_timestamp: z.string().nullable(),
  })
  .nullable();

const TopHolderSchema = z.object({
  address: z.string(),
  value: z.string().nullable(),
  percent: z.number().nullable(),
  category: z.enum(HOLDER_CATEGORIES),
});

export type TopHolder = z.infer<typeof TopHolderSchema>;

export const ForensicsResponseSchema = z.object({
  address: z.string(),
  chain: z.literal('base'),
  token: TokenOutSchema,
  deployer: DeployerOutSchema,
  token_activity: z
    .object({
      last_active_timestamp: z.string().nullable(),
      recent_methods: z.array(z.string()).nullable(),
    })
    .nullable(),
  holder_count: z.number().int().nonnegative().nullable(),
  top10_concentration_pct: z.number().nullable(),
  circulating_top10_concentration_pct: z.number().nullable(),
  top_holders: z.array(TopHolderSchema),
  deployer_holdings_pct: z.number().nullable(),
  lp_locked_heuristic: z.boolean().nullable(),
  flags: z.array(FlagSchema),
});

export type ForensicsResponse = z.infer<typeof ForensicsResponseSchema>;

const DEAD_ADDRESSES = new Set<string>([
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
]);

function toLowerHex(s: string | null | undefined): string | null {
  return typeof s === 'string' && s.length > 0 ? s.toLowerCase() : null;
}

function coerceInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function coerceBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/u.test(v.trim())) {
    try {
      return BigInt(v.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function readRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' ? (v as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
}

function percentBigInt(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  const scaled = (numerator * 10_000n) / denominator;
  return Number(scaled) / 100;
}

function extractHolders(
  holders: BlockscoutHolders,
): Array<{ address: string | null; value: bigint | null }> {
  const items = holders.items ?? [];
  return items.map((h) => ({
    address: toLowerHex(h.address?.hash ?? null),
    value: coerceBigInt(h.value),
  }));
}

function top10ConcentrationPct(
  holders: Array<{ value: bigint | null }>,
  totalSupply: bigint | null,
): number | null {
  if (!totalSupply || totalSupply <= 0n) return null;
  if (holders.length === 0) return null;
  const values = holders
    .map((h) => h.value)
    .filter((v): v is bigint => v !== null && v >= 0n)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    .slice(0, 10);
  if (values.length === 0) return null;
  const sum = values.reduce<bigint>((acc, v) => acc + v, 0n);
  return percentBigInt(sum, totalSupply);
}

function deployerHoldingsPct(
  holders: Array<{ address: string | null; value: bigint | null }>,
  totalSupply: bigint | null,
  deployerAddress: string | null,
): number | null {
  if (!deployerAddress || !totalSupply || totalSupply <= 0n) return null;
  const needle = deployerAddress.toLowerCase();
  const match = holders.find((h) => h.address === needle);
  if (!match || match.value === null) return null;
  return percentBigInt(match.value, totalSupply);
}

function lpLockedFromPairHolders(pairHolders: BlockscoutHolders | null): boolean | null {
  if (!pairHolders) return null;
  const items = pairHolders.items ?? [];
  if (items.length === 0) return null;
  const parsed = items.map((h) => ({
    address: toLowerHex(h.address?.hash ?? null),
    value: coerceBigInt(h.value),
  }));
  const top5 = parsed
    .filter((h): h is { address: string; value: bigint } => h.address !== null && h.value !== null)
    .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
    .slice(0, 5);
  for (const h of top5) {
    if (DEAD_ADDRESSES.has(h.address)) return true;
  }
  return false;
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /not[_ ]?found|\b404\b/iu.test(msg);
}

function looksLikeMissingToken(token: BlockscoutToken): boolean {
  const rec = readRecord(token);
  const msg = typeof rec.message === 'string' ? rec.message : '';
  if (/not found/iu.test(msg)) return true;
  return !token.name && !token.symbol && !token.total_supply && !token.type;
}

function extractCreatorFromToken(token: BlockscoutToken): string | null {
  const rec = readRecord(token);
  const direct = typeof rec.creator_address_hash === 'string' ? rec.creator_address_hash : null;
  if (direct) return direct;
  const nested = readRecord(rec.token);
  const fromNested =
    typeof nested.creator_address_hash === 'string' ? nested.creator_address_hash : null;
  return fromNested;
}

function extractTxCount(addr: BlockscoutAddress): number | null {
  const rec = readRecord(addr);
  return (
    coerceInt(rec.transactions_count) ??
    coerceInt(rec.tx_count) ??
    coerceInt(rec.transaction_count) ??
    null
  );
}

function extractVerified(
  token: BlockscoutToken,
  deployerContract: BlockscoutAddress | null,
): boolean | null {
  const tokenRec = readRecord(token);
  if (typeof tokenRec.is_verified === 'boolean') return tokenRec.is_verified;
  const nested = readRecord(tokenRec.token);
  if (typeof nested.is_verified === 'boolean') return nested.is_verified;
  if (deployerContract && typeof deployerContract.is_verified === 'boolean') {
    return deployerContract.is_verified;
  }
  return null;
}

export type ForensicsErrorCode =
  | 'no_blockscout'
  | 'token_not_found'
  | 'upstream_failure'
  | 'response_invalid';

export class ForensicsHelperError extends Error {
  readonly code: ForensicsErrorCode;
  readonly detail?: string;
  constructor(code: ForensicsErrorCode, detail?: string) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
    this.name = 'ForensicsHelperError';
  }
}

/**
 * Fetch + normalize Blockscout forensics for a token. When `pair` is provided
 * and well-formed, the top-5 LP-token holders are inspected to populate
 * `lp_locked_heuristic`.
 */
export async function fetchForensicsSummary(
  blockscout: ForensicsBlockscout | null,
  address: string,
  pair: string | null = null,
): Promise<ForensicsResponse> {
  if (!blockscout) throw new ForensicsHelperError('no_blockscout');

  const pairAddr = pair && /^0x[a-fA-F0-9]{40}$/u.test(pair) ? pair : null;

  let tokenInfo: BlockscoutToken;
  let holdersResp: BlockscoutHolders;
  let pairHoldersResp: BlockscoutHolders | null = null;
  let tokenTxs: BlockscoutAddressTxs | null = null;

  try {
    const [tokenResult, holdersResult, pairHoldersResult, tokenTxsResult] = await Promise.all([
      blockscout.getToken(address, 'base'),
      blockscout.getTokenHolders(address, 'base'),
      pairAddr
        ? blockscout.getTokenHolders(pairAddr, 'base').catch(() => null)
        : Promise.resolve(null),
      blockscout.getAddressTransactions(address, 'base').catch(() => null),
    ]);
    tokenInfo = tokenResult;
    holdersResp = holdersResult;
    pairHoldersResp = pairHoldersResult;
    tokenTxs = tokenTxsResult;
  } catch (err) {
    if (isNotFoundError(err)) throw new ForensicsHelperError('token_not_found');
    throw new ForensicsHelperError(
      'upstream_failure',
      err instanceof Error ? err.message : undefined,
    );
  }

  if (looksLikeMissingToken(tokenInfo)) {
    throw new ForensicsHelperError('token_not_found');
  }

  let creatorHash = toLowerHex(extractCreatorFromToken(tokenInfo));
  let contractAddrInfo: BlockscoutAddress | null = null;
  if (!creatorHash) {
    try {
      contractAddrInfo = await blockscout.getAddress(address, 'base');
      creatorHash = toLowerHex(contractAddrInfo.creator_address_hash ?? null);
    } catch {
      contractAddrInfo = null;
    }
  }

  let deployerInfo: z.infer<typeof DeployerOutSchema> = null;
  if (creatorHash) {
    try {
      const [addr, txs] = await Promise.all([
        blockscout.getAddress(creatorHash, 'base'),
        blockscout.getAddressTransactions(creatorHash, 'base').catch(() => null),
      ]);
      deployerInfo = {
        address: creatorHash,
        is_contract: typeof addr.is_contract === 'boolean' ? addr.is_contract : null,
        tx_count: extractTxCount(addr),
        coin_balance: addr.coin_balance ?? null,
        creation_tx_hash: addr.creation_tx_hash ?? null,
        last_active_timestamp: txs?.items?.[0]?.timestamp ?? null,
      };
    } catch {
      deployerInfo = {
        address: creatorHash,
        is_contract: null,
        tx_count: null,
        coin_balance: null,
        creation_tx_hash: null,
        last_active_timestamp: null,
      };
    }
  }

  const holders = extractHolders(holdersResp);
  const totalSupply = coerceBigInt(tokenInfo.total_supply);
  const top10Pct = top10ConcentrationPct(holders, totalSupply);
  const deployerPct = deployerHoldingsPct(holders, totalSupply, creatorHash);
  const lpLocked = lpLockedFromPairHolders(pairHoldersResp);
  const verified = extractVerified(tokenInfo, contractAddrInfo);

  // Pull the top-10 holders (by value) and classify each so consumers can
  // tell raw concentration apart from circulating-supply concentration.
  const top10Holders = holders
    .filter((h): h is { address: string; value: bigint } => h.address !== null && h.value !== null)
    .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
    .slice(0, 10);

  const top10Lookups = await Promise.all(
    top10Holders.map(async (h) => {
      try {
        const info = await blockscout.getAddress(h.address, 'base');
        return typeof info.is_contract === 'boolean' ? info.is_contract : null;
      } catch {
        return null;
      }
    }),
  );

  const topHolders: TopHolder[] = top10Holders.map((h, i) => {
    const category: HolderCategory = classifyHolder(h.address, top10Lookups[i] ?? null, creatorHash);
    return {
      address: h.address,
      value: h.value.toString(),
      percent: percentBigInt(h.value, totalSupply ?? 0n),
      category,
    };
  });

  const circulatingTop10Pct = (() => {
    if (!totalSupply || totalSupply <= 0n) return null;
    if (topHolders.length === 0) return null;
    let nonCirculating = 0n;
    for (const h of topHolders) {
      if (NON_CIRCULATING_CATEGORIES.has(h.category)) {
        try {
          nonCirculating += BigInt(h.value ?? '0');
        } catch {
          /* skip malformed value */
        }
      }
    }
    // Also subtract burn/bridge holders that fall *outside* top-10 from the
    // denominator when they appear in the wider holder list — otherwise the
    // adjusted figure is still skewed by, e.g., a large burn balance ranked
    // 11th. This is a best-effort pass; we only have what Blockscout
    // returned in `holders`.
    for (const h of holders) {
      if (h.address === null || h.value === null) continue;
      if (topHolders.some((t) => t.address === h.address)) continue;
      const a = h.address;
      // Re-classify without an `is_contract` lookup: only burn + bridge are
      // identifiable from address alone, which is exactly what we need.
      const cat = classifyHolder(a, null, creatorHash);
      if (NON_CIRCULATING_CATEGORIES.has(cat)) {
        nonCirculating += h.value;
      }
    }
    const denominator = totalSupply - nonCirculating;
    if (denominator <= 0n) return null;
    const circulatingTop10Sum = topHolders
      .filter((h) => !NON_CIRCULATING_CATEGORIES.has(h.category))
      .reduce<bigint>((acc, h) => {
        try {
          return acc + BigInt(h.value ?? '0');
        } catch {
          return acc;
        }
      }, 0n);
    return percentBigInt(circulatingTop10Sum, denominator);
  })();

  const holderCount = (() => {
    const rec = readRecord(tokenInfo);
    const declared = coerceInt(rec.holders_count ?? rec.holders);
    if (declared !== null) return declared;
    const items = holdersResp.items ?? [];
    return items.length > 0 ? items.length : null;
  })();

  const decimals = coerceInt(tokenInfo.decimals);

  const tokenActivity = tokenTxs
    ? {
        last_active_timestamp: tokenTxs.items?.[0]?.timestamp ?? null,
        recent_methods: Array.from(
          new Set(
            (tokenTxs.items ?? [])
              .map((tx) => tx.method)
              .filter((m): m is string => typeof m === 'string' && m.length > 0),
          ),
        ).slice(0, 5),
      }
    : null;

  const flags = computeFlags({
    top10ConcentrationPct: circulatingTop10Pct ?? top10Pct,
    deployerHoldingsPct: deployerPct,
    verified,
    lpLocked,
  });

  const payload: ForensicsResponse = {
    address,
    chain: 'base',
    token: {
      name: tokenInfo.name ?? null,
      symbol: tokenInfo.symbol ?? null,
      decimals,
      total_supply: tokenInfo.total_supply ?? null,
      circulating_market_cap: tokenInfo.circulating_market_cap ?? null,
      exchange_rate: tokenInfo.exchange_rate ?? null,
      type: tokenInfo.type ?? null,
      verified,
    },
    deployer: deployerInfo,
    token_activity: tokenActivity,
    holder_count: holderCount,
    top10_concentration_pct: top10Pct,
    circulating_top10_concentration_pct: circulatingTop10Pct,
    top_holders: topHolders,
    deployer_holdings_pct: deployerPct,
    lp_locked_heuristic: lpLocked,
    flags,
  };

  const validated = ForensicsResponseSchema.safeParse(payload);
  if (!validated.success) {
    throw new ForensicsHelperError('response_invalid', validated.error.message);
  }
  return validated.data;
}

export function forensicsCacheKey(address: string, pair: string | null | undefined): string {
  return pair ? `forensics:${address}:${pair.toLowerCase()}` : `forensics:${address}`;
}

export async function cachedFetchForensicsSummary(
  blockscout: ForensicsBlockscout | null,
  address: string,
  pair: string | null,
  cache: TtlLruCache<unknown> | null,
): Promise<ForensicsResponse> {
  if (!cache) return fetchForensicsSummary(blockscout, address, pair);
  const key = forensicsCacheKey(address, pair);
  const hit = cache.get(key) as ForensicsResponse | undefined;
  if (hit !== undefined) return hit;
  const value = await fetchForensicsSummary(blockscout, address, pair);
  cache.set(key, value);
  return value;
}
