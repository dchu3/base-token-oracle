import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createMarketRouter } from '../../src/routes/market.js';
import { TtlLruCache } from '../../src/cache.js';
import type { DexScreenerPair } from '../../src/mcp/dexScreener.js';

function makeApp(getTokenPools: (chainId: string, address: string) => Promise<DexScreenerPair[]>) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/x402/base',
    createMarketRouter({ dexScreener: { getTokenPools } }),
  );
  return app;
}

const VALID = '0x1111111111111111111111111111111111111111';

describe('GET /api/v1/x402/base/token/:address/market', () => {
  it('returns 400 for invalid address', async () => {
    const spy = vi.fn();
    const app = makeApp(spy);
    const res = await request(app).get('/api/v1/x402/base/token/not-an-address/market');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_address' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 for 0x-prefixed but wrong-length', async () => {
    const app = makeApp(async () => []);
    const res = await request(app).get('/api/v1/x402/base/token/0xabc/market');
    expect(res.status).toBe(400);
  });

  it('returns 404 when no pools are found', async () => {
    const app = makeApp(async () => []);
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/market`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'no_pools_found' });
  });

  it('returns 200 with the expected shape, selecting the highest-liquidity pool', async () => {
    const pools: DexScreenerPair[] = [
      {
        chainId: 'base',
        dexId: 'aerodrome',
        pairAddress: '0xpair-low',
        baseToken: { address: VALID, symbol: 'XYZ' },
        quoteToken: { address: '0xweth', symbol: 'WETH' },
        priceUsd: '0.00100',
        liquidity: { usd: 5_000 },
        volume: { h24: 1_000 },
        priceChange: { h24: -1.0 },
        fdv: 1_000,
        marketCap: 900,
        pairCreatedAt: 1_700_000_000_000,
      },
      {
        chainId: 'base',
        dexId: 'uniswap',
        pairAddress: '0xpair-high',
        baseToken: { address: VALID, symbol: 'XYZ' },
        quoteToken: { address: '0xweth', symbol: 'WETH' },
        priceUsd: '0.00123',
        liquidity: { usd: 25_000 },
        volume: { h24: 50_000 },
        priceChange: { h24: -4.2 },
        fdv: 1_234_567,
        marketCap: 1_000_000,
        pairCreatedAt: 1_704_171_845_000,
      },
    ];
    const app = makeApp(async (chain, addr) => {
      expect(chain).toBe('base');
      expect(addr).toBe(VALID.toLowerCase());
      return pools;
    });

    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/market`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: VALID.toLowerCase(),
      chain: 'base',
      price_usd: 0.00123,
      price_change_24h_pct: -4.2,
      fdv: 1_234_567,
      market_cap: 1_000_000,
      volume_24h_usd: 50_000,
      liquidity_usd: 25_000,
      top_pool: {
        pair_address: '0xpair-high',
        dex_id: 'uniswap',
        base_token_symbol: 'XYZ',
        quote_token_symbol: 'WETH',
        pair_created_at: new Date(1_704_171_845_000).toISOString(),
      },
      pool_count: 2,
    });
  });

  it('fills missing upstream fields with null (keys always present)', async () => {
    const pools: DexScreenerPair[] = [
      {
        chainId: 'base',
        pairAddress: '0xpair',
        baseToken: { address: VALID },
        quoteToken: { address: '0xweth' },
        liquidity: { usd: 10 },
      },
    ];
    const app = makeApp(async () => pools);
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/market`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      price_usd: null,
      price_change_24h_pct: null,
      fdv: null,
      market_cap: null,
      volume_24h_usd: null,
      liquidity_usd: 10,
      top_pool: {
        pair_address: '0xpair',
        dex_id: null,
        base_token_symbol: null,
        quote_token_symbol: null,
        pair_created_at: null,
      },
      pool_count: 1,
    });
    // explicit key-presence check
    for (const key of [
      'price_usd',
      'price_change_24h_pct',
      'fdv',
      'market_cap',
      'volume_24h_usd',
      'liquidity_usd',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(res.body, key)).toBe(true);
    }
  });

  it('returns 502 when upstream throws', async () => {
    const app = makeApp(async () => {
      throw new Error('mcp down');
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/market`);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_failure' });
  });

  it('returns 502 when dexScreener dep is null', async () => {
    const app = express();
    app.use('/api/v1/x402/base', createMarketRouter({ dexScreener: null }));
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/market`);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_failure' });
  });

  it('accepts mixed-case addresses and lowercases them', async () => {
    const mixed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    let seen: string | undefined;
    const app = makeApp(async (_chain, addr) => {
      seen = addr;
      return [];
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${mixed}/market`);
    expect(res.status).toBe(404);
    expect(seen).toBe(mixed.toLowerCase());
  });

  it('caches successful responses — same address hits upstream only once within TTL', async () => {
    const pools: DexScreenerPair[] = [
      {
        chainId: 'base',
        dexId: 'uniswap',
        pairAddress: '0xpair',
        baseToken: { address: VALID, symbol: 'XYZ' },
        quoteToken: { address: '0xweth', symbol: 'WETH' },
        priceUsd: '1.00',
        liquidity: { usd: 100_000 },
      },
    ];
    const spy = vi.fn(async () => pools);
    const cache = new TtlLruCache<unknown>({ ttlMs: 45_000, max: 10 });
    const app = express();
    app.use('/api/v1/x402/base', createMarketRouter({ dexScreener: { getTokenPools: spy }, cache }));

    const r1 = await request(app).get(`/api/v1/x402/base/token/${VALID}/market`);
    const r2 = await request(app).get(`/api/v1/x402/base/token/${VALID}/market`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
