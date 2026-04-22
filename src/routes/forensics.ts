import { Router, type Request, type Response } from 'express';
import {
  cachedFetchForensicsSummary,
  fetchForensicsSummary,
  ForensicsHelperError,
  type ForensicsBlockscout,
  type ForensicsResponse,
} from '../services/forensics.js';
import type { TtlLruCache } from '../cache.js';

export type { ForensicsBlockscout, ForensicsResponse } from '../services/forensics.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/u;

export interface ForensicsDeps {
  blockscout: ForensicsBlockscout;
  cache?: TtlLruCache<unknown> | null;
}

export function createForensicsRouter(deps: ForensicsDeps): Router {
  const router = Router();
  const cache = deps.cache ?? null;

  router.get('/token/:address/forensics', async (req: Request, res: Response) => {
    const rawAddr = req.params.address ?? '';
    if (!ADDRESS_REGEX.test(rawAddr)) {
      res.status(400).json({ error: 'invalid_address' });
      return;
    }
    const address = rawAddr.toLowerCase();
    const pairQuery = typeof req.query.pair === 'string' ? req.query.pair : undefined;
    const pairAddr = pairQuery && ADDRESS_REGEX.test(pairQuery) ? pairQuery.toLowerCase() : null;

    let body: ForensicsResponse;
    try {
      body = cache
        ? await cachedFetchForensicsSummary(deps.blockscout, address, pairAddr, cache)
        : await fetchForensicsSummary(deps.blockscout, address, pairAddr);
    } catch (err) {
      if (err instanceof ForensicsHelperError) {
        if (err.code === 'token_not_found') {
          res.status(404).json({ error: 'token_not_found' });
          return;
        }
        if (err.code === 'response_invalid') {
          res.status(502).json({ error: 'response_validation_failed', detail: err.detail });
          return;
        }
        res.status(502).json({ error: 'upstream_error', detail: err.detail ?? err.code });
        return;
      }
      res.status(502).json({ error: 'upstream_error', detail: errorMessage(err) });
      return;
    }
    res.json(body);
  });

  return router;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown error';
  }
}
