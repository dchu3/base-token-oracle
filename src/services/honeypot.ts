import { z } from 'zod';
import type { HoneypotCheck, HoneypotInput } from '../mcp/honeypot.js';
import type { TtlLruCache } from '../cache.js';

/** Chain identifier passed to the honeypot MCP server. */
export const BASE_CHAIN: HoneypotInput['chain'] = 'base';

export interface HoneypotCheckService {
  checkToken(input: HoneypotInput): Promise<HoneypotCheck>;
}

export const NormalizedHoneypotSchema = z.object({
  address: z.string(),
  chain: z.literal('base'),
  is_honeypot: z.boolean().nullable(),
  buy_tax: z.number().nullable(),
  sell_tax: z.number().nullable(),
  transfer_tax: z.number().nullable(),
  simulation_success: z.boolean().nullable(),
  honeypot_reason: z.string().nullable(),
  flags: z.array(z.string()),
});

export type NormalizedHoneypot = z.infer<typeof NormalizedHoneypotSchema>;

const UpstreamShapeSchema = z
  .object({
    summary: z
      .object({
        verdict: z.string().optional(),
        reason: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    taxes: z
      .object({
        buyBps: z.number().optional(),
        sellBps: z.number().optional(),
        transferBps: z.number().optional(),
        buyTax: z.number().optional(),
        sellTax: z.number().optional(),
        transferTax: z.number().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    flags: z.array(z.string()).optional(),
    risk: z
      .object({
        description: z.string().optional(),
        recommendation: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    honeypotResult: z
      .object({
        isHoneypot: z.boolean().optional(),
        honeypotReason: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    simulationResult: z
      .object({
        buyTax: z.number().optional(),
        sellTax: z.number().optional(),
        transferTax: z.number().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    simulationSuccess: z.boolean().optional(),
  })
  .passthrough();

function bpsToPercent(bps: number | undefined, pct: number | undefined): number | null {
  if (typeof pct === 'number' && Number.isFinite(pct)) return pct;
  if (typeof bps === 'number' && Number.isFinite(bps)) return bps / 100;
  return null;
}

function computeFlags(n: {
  is_honeypot: boolean | null;
  buy_tax: number | null;
  sell_tax: number | null;
  simulation_success: boolean | null;
}): string[] {
  const flags: string[] = [];
  if (n.is_honeypot === true) flags.push('honeypot');
  if (n.simulation_success === false) flags.push('simulation_failed');
  if (n.buy_tax !== null && n.buy_tax > 10) flags.push('high_buy_tax');
  if (n.sell_tax !== null && n.sell_tax > 10) flags.push('high_sell_tax');
  return flags;
}

export function normalizeHoneypot(address: string, raw: HoneypotCheck): NormalizedHoneypot {
  const parsed = UpstreamShapeSchema.safeParse(raw);
  const u = parsed.success ? parsed.data : {};

  const is_honeypot = u.honeypotResult?.isHoneypot ?? null;

  const buy_tax = bpsToPercent(u.taxes?.buyBps, u.taxes?.buyTax ?? u.simulationResult?.buyTax);
  const sell_tax = bpsToPercent(u.taxes?.sellBps, u.taxes?.sellTax ?? u.simulationResult?.sellTax);
  const transfer_tax = bpsToPercent(
    u.taxes?.transferBps,
    u.taxes?.transferTax ?? u.simulationResult?.transferTax,
  );

  const simulation_success = u.simulationSuccess ?? null;

  const honeypot_reason =
    u.honeypotResult?.honeypotReason ?? u.summary?.reason ?? u.risk?.description ?? null;

  const partial = { is_honeypot, buy_tax, sell_tax, transfer_tax, simulation_success };
  return {
    address,
    chain: 'base',
    ...partial,
    honeypot_reason,
    flags: computeFlags(partial),
  };
}

const NOT_ANALYZABLE_PATTERNS = [
  /not\s+found/i,
  /no\s+pair/i,
  /no\s+pool/i,
  /no\s+liquidity/i,
  /cannot\s+simulate/i,
  /no_pair/i,
  /pair_not_found/i,
  /token_not_found/i,
];

function isNotAnalyzableError(err: unknown): string | null {
  if (err instanceof Error) {
    for (const re of NOT_ANALYZABLE_PATTERNS) {
      if (re.test(err.message)) return err.message;
    }
  }
  return null;
}

export type HoneypotErrorCode =
  | 'no_honeypot'
  | 'not_analyzable'
  | 'upstream_failure'
  | 'response_invalid';

export class HoneypotHelperError extends Error {
  readonly code: HoneypotErrorCode;
  readonly detail?: string;
  constructor(code: HoneypotErrorCode, detail?: string) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
    this.name = 'HoneypotHelperError';
  }
}

/**
 * Fetch + normalize Honeypot.is check for a token.
 */
export async function fetchHoneypotSummary(
  honeypot: HoneypotCheckService | null,
  address: string,
): Promise<NormalizedHoneypot> {
  if (!honeypot) throw new HoneypotHelperError('no_honeypot');
  let upstream: HoneypotCheck;
  try {
    upstream = await honeypot.checkToken({ address, chain: BASE_CHAIN });
  } catch (err) {
    const notAnalyzable = isNotAnalyzableError(err);
    if (notAnalyzable) throw new HoneypotHelperError('not_analyzable', notAnalyzable);
    throw new HoneypotHelperError(
      'upstream_failure',
      err instanceof Error ? err.message : undefined,
    );
  }

  const normalized = normalizeHoneypot(address, upstream);
  const validated = NormalizedHoneypotSchema.safeParse(normalized);
  if (!validated.success) {
    throw new HoneypotHelperError('response_invalid', validated.error.message);
  }
  return validated.data;
}

export function honeypotCacheKey(address: string): string {
  return `honeypot:${address}`;
}

export async function cachedFetchHoneypotSummary(
  honeypot: HoneypotCheckService | null,
  address: string,
  cache: TtlLruCache<unknown> | null,
): Promise<NormalizedHoneypot> {
  if (!cache) return fetchHoneypotSummary(honeypot, address);
  const key = honeypotCacheKey(address);
  const hit = cache.get(key) as NormalizedHoneypot | undefined;
  if (hit !== undefined) return hit;
  const value = await fetchHoneypotSummary(honeypot, address);
  cache.set(key, value);
  return value;
}
