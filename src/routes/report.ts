import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  cachedFetchMarketSummary,
  MarketResponseSchema,
  type DexScreenerLike,
  type MarketResponse,
} from '../services/market.js';
import {
  cachedFetchHoneypotSummary,
  NormalizedHoneypotSchema,
  type HoneypotCheckService,
  type NormalizedHoneypot,
} from '../services/honeypot.js';
import {
  cachedFetchForensicsSummary,
  ForensicsResponseSchema,
  type ForensicsBlockscout,
  type ForensicsResponse,
} from '../services/forensics.js';
import { computeRisk, type RiskInputs, type RiskOutput } from '../risk/engine.js';
import type { TtlLruCache } from '../cache.js';

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/u;

const UnavailableSchema = z.object({
  available: z.literal(false),
  error: z.string(),
});

const RiskSchema = z.object({
  score: z.number(),
  level: z.enum(['clean', 'caution', 'risky', 'critical']),
  flags: z.array(z.string()),
});

export const ReportResponseSchema = z.object({
  address: z.string(),
  chain: z.literal('base'),
  market: z.union([MarketResponseSchema, UnavailableSchema]),
  honeypot: z.union([NormalizedHoneypotSchema, UnavailableSchema]),
  forensics: z.union([ForensicsResponseSchema, UnavailableSchema]),
  risk: RiskSchema,
  generated_at: z.string(),
});

export type ReportResponse = z.infer<typeof ReportResponseSchema>;

type Unavailable = z.infer<typeof UnavailableSchema>;

/**
 * Test hooks — injecting the three helpers lets unit tests spy on
 * `fetchForensicsSummary` and assert that the market-derived `pair_address`
 * is forwarded. Defaults to the real cache-aware helpers.
 */
export interface ReportRouterHelpers {
  market: (
    ds: DexScreenerLike | null,
    address: string,
    cache: TtlLruCache<unknown> | null,
  ) => Promise<MarketResponse>;
  honeypot: (
    hp: HoneypotCheckService | null,
    address: string,
    cache: TtlLruCache<unknown> | null,
  ) => Promise<NormalizedHoneypot>;
  forensics: (
    bs: ForensicsBlockscout | null,
    address: string,
    pair: string | null,
    cache: TtlLruCache<unknown> | null,
  ) => Promise<ForensicsResponse>;
}

export interface ReportRouterDeps {
  dexScreener: DexScreenerLike | null;
  honeypot: HoneypotCheckService | null;
  blockscout: ForensicsBlockscout | null;
  cache?: TtlLruCache<unknown> | null;
  helpers?: Partial<ReportRouterHelpers>;
}

const DEFAULT_HELPERS: ReportRouterHelpers = {
  market: cachedFetchMarketSummary,
  honeypot: cachedFetchHoneypotSummary,
  forensics: cachedFetchForensicsSummary,
};

function unavailable(error = 'upstream_failure'): Unavailable {
  return { available: false, error };
}

function hoursBetween(iso: string | null, nowMs: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return (nowMs - t) / (1000 * 60 * 60);
}

function buildRiskInputs(
  market: MarketResponse | Unavailable,
  honeypot: NormalizedHoneypot | Unavailable,
  forensics: ForensicsResponse | Unavailable,
  nowMs: number,
): RiskInputs {
  const inputs: RiskInputs = {};

  if (!('available' in honeypot) && honeypot.is_honeypot !== null) {
    const hp: RiskInputs['honeypot'] = { is_honeypot: honeypot.is_honeypot };
    if (honeypot.buy_tax !== null) hp.buy_tax = honeypot.buy_tax;
    if (honeypot.sell_tax !== null) hp.sell_tax = honeypot.sell_tax;
    if (honeypot.transfer_tax !== null) hp.transfer_tax = honeypot.transfer_tax;
    inputs.honeypot = hp;
  }

  if (!('available' in forensics)) {
    const f: RiskInputs['forensics'] = {};
    if (forensics.top10_concentration_pct !== null)
      f.top10_concentration_pct = forensics.top10_concentration_pct;
    if (forensics.deployer_holdings_pct !== null)
      f.deployer_holdings_pct = forensics.deployer_holdings_pct;
    if (forensics.lp_locked_heuristic !== null) f.lp_locked = forensics.lp_locked_heuristic;
    if (Object.keys(f).length > 0) inputs.forensics = f;
  }

  if (!('available' in market)) {
    const m: RiskInputs['market'] = {};
    if (market.liquidity_usd !== null) m.liquidity_usd = market.liquidity_usd;
    const age = hoursBetween(market.top_pool.pair_created_at, nowMs);
    if (age !== undefined) m.pair_age_hours = age;
    if (Object.keys(m).length > 0) inputs.market = m;
  }

  return inputs;
}

export function createReportRouter(deps: ReportRouterDeps): Router {
  const router = Router();
  const cache = deps.cache ?? null;
  const helpers: ReportRouterHelpers = { ...DEFAULT_HELPERS, ...(deps.helpers ?? {}) };

  router.get(
    '/token/:address/report',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const raw = req.params.address ?? '';
        if (!ADDRESS_REGEX.test(raw)) {
          res.status(400).json({ error: 'invalid_address' });
          return;
        }
        const address = raw.toLowerCase();

        // Three-way fan-out: market, honeypot, and forensics all fire
        // concurrently. Forensics wants the `pair_address` from market (for
        // the LP-locked heuristic) but we don't want a slow market call to
        // serialize the entire report — so we race market against a soft
        // deadline and fall back to a pairless forensics fetch on timeout.
        const marketP = helpers.market(deps.dexScreener, address, cache);
        const honeypotP = helpers.honeypot(deps.honeypot, address, cache);
        const PAIR_SOFT_DEADLINE_MS = 1500;
        const pairP: Promise<string | null> = Promise.race([
          marketP.then(
            (m) => m.top_pool.pair_address ?? null,
            () => null,
          ),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), PAIR_SOFT_DEADLINE_MS)),
        ]);
        const forensicsP = (async (): Promise<ForensicsResponse> => {
          const pair = await pairP;
          return helpers.forensics(deps.blockscout, address, pair, cache);
        })();

        const [marketResult, honeypotResult, forensicsResult] = await Promise.allSettled([
          marketP,
          honeypotP,
          forensicsP,
        ]);

        const market: MarketResponse | Unavailable =
          marketResult.status === 'fulfilled' ? marketResult.value : unavailable();
        const honeypot: NormalizedHoneypot | Unavailable =
          honeypotResult.status === 'fulfilled' ? honeypotResult.value : unavailable();
        const forensics: ForensicsResponse | Unavailable =
          forensicsResult.status === 'fulfilled' ? forensicsResult.value : unavailable();

        const availableCount =
          ('available' in market ? 0 : 1) +
          ('available' in honeypot ? 0 : 1) +
          ('available' in forensics ? 0 : 1);

        if (availableCount === 0) {
          res.status(502).json({ error: 'all_upstream_failed' });
          return;
        }

        const now = Date.now();
        const riskInputs = buildRiskInputs(market, honeypot, forensics, now);
        const risk: RiskOutput = computeRisk(riskInputs);

        const payload: ReportResponse = {
          address,
          chain: 'base',
          market,
          honeypot,
          forensics,
          risk,
          generated_at: new Date(now).toISOString(),
        };

        const validated = ReportResponseSchema.safeParse(payload);
        if (!validated.success) {
          res
            .status(502)
            .json({ error: 'response_validation_failed', detail: validated.error.message });
          return;
        }
        res.status(200).json(validated.data);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
