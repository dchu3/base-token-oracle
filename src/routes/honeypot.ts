import { Router, type Request, type Response } from 'express';
import {
  cachedFetchHoneypotSummary,
  fetchHoneypotSummary,
  HoneypotHelperError,
  type HoneypotCheckService,
  type NormalizedHoneypot,
} from '../services/honeypot.js';
import type { TtlLruCache } from '../cache.js';

export type { HoneypotCheckService, NormalizedHoneypot } from '../services/honeypot.js';

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

export interface HoneypotRouterDeps {
  honeypot: HoneypotCheckService;
  cache?: TtlLruCache<unknown> | null;
}

export function createHoneypotRouter(deps: HoneypotRouterDeps): Router {
  const router = Router();
  const cache = deps.cache ?? null;

  router.get('/token/:address/honeypot', async (req: Request, res: Response) => {
    const raw = req.params.address;
    if (!raw || !ADDRESS_REGEX.test(raw)) {
      return res.status(400).json({ error: 'invalid_address' });
    }
    const address = raw.toLowerCase();

    let data: NormalizedHoneypot;
    try {
      data = cache
        ? await cachedFetchHoneypotSummary(deps.honeypot, address, cache)
        : await fetchHoneypotSummary(deps.honeypot, address);
    } catch (err) {
      if (err instanceof HoneypotHelperError) {
        if (err.code === 'not_analyzable') {
          return res.status(404).json({ error: 'token_not_analyzable', detail: err.detail });
        }
        return res.status(502).json({ error: 'upstream_failure' });
      }
      return res.status(502).json({ error: 'upstream_failure' });
    }
    return res.status(200).json(data);
  });

  return router;
}
