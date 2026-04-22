import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  cachedFetchMarketSummary,
  fetchMarketSummary,
  MarketError,
  type DexScreenerLike,
  type MarketResponse,
} from '../services/market.js';
import type { TtlLruCache } from '../cache.js';

export type { MarketResponse } from '../services/market.js';

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export interface MarketRouterDeps {
  dexScreener: DexScreenerLike | null;
  cache?: TtlLruCache<unknown> | null;
}

export function createMarketRouter(deps: MarketRouterDeps): Router {
  const router = Router();
  const cache = deps.cache ?? null;

  router.get(
    '/token/:address/market',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rawAddress = req.params.address ?? '';
        if (!ADDRESS_REGEX.test(rawAddress)) {
          res.status(400).json({ error: 'invalid_address' });
          return;
        }
        const address = rawAddress.toLowerCase();

        let body: MarketResponse;
        try {
          body = cache
            ? await cachedFetchMarketSummary(deps.dexScreener, address, cache)
            : await fetchMarketSummary(deps.dexScreener, address);
        } catch (err) {
          if (err instanceof MarketError) {
            if (err.code === 'no_pools_found') {
              res.status(404).json({ error: 'no_pools_found' });
              return;
            }
            res.status(502).json({ error: 'upstream_failure' });
            return;
          }
          throw err;
        }
        res.status(200).json(body);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
