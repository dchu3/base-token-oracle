import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createReportRouter, type ReportRouterHelpers } from '../../src/routes/report.js';
import type { MarketResponse } from '../../src/services/market.js';
import type { NormalizedHoneypot } from '../../src/services/honeypot.js';
import type { ForensicsResponse } from '../../src/services/forensics.js';

const VALID = '0x1111111111111111111111111111111111111111';
const PAIR = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

function marketOk(overrides: Partial<MarketResponse> = {}): MarketResponse {
  return {
    address: VALID,
    chain: 'base',
    price_usd: 1.23,
    price_change_24h_pct: 2.0,
    fdv: 1_000_000,
    market_cap: 900_000,
    volume_24h_usd: 50_000,
    liquidity_usd: 100_000,
    top_pool: {
      pair_address: PAIR,
      dex_id: 'uniswap',
      base_token_symbol: 'XYZ',
      quote_token_symbol: 'WETH',
      pair_created_at: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
    },
    pool_count: 1,
    ...overrides,
  };
}

function honeypotClean(): NormalizedHoneypot {
  return {
    address: VALID,
    chain: 'base',
    is_honeypot: false,
    buy_tax: 1,
    sell_tax: 1,
    transfer_tax: 0,
    simulation_success: true,
    honeypot_reason: null,
    flags: [],
  };
}

function honeypotBad(): NormalizedHoneypot {
  return {
    address: VALID,
    chain: 'base',
    is_honeypot: true,
    buy_tax: 12,
    sell_tax: 99,
    transfer_tax: 0,
    simulation_success: false,
    honeypot_reason: 'cannot sell',
    flags: ['honeypot', 'simulation_failed', 'high_buy_tax', 'high_sell_tax'],
  };
}

function forensicsClean(): ForensicsResponse {
  return {
    address: VALID,
    chain: 'base',
    token: {
      name: 'X',
      symbol: 'X',
      decimals: 18,
      total_supply: '1000000000000000000000000',
      type: 'ERC-20',
      verified: true,
    },
    deployer: { address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', is_contract: false, tx_count: 100 },
    holder_count: 500,
    top10_concentration_pct: 30,
    deployer_holdings_pct: 5,
    lp_locked_heuristic: true,
    flags: ['lp_locked'],
  };
}

function forensicsHot(): ForensicsResponse {
  return {
    ...forensicsClean(),
    top10_concentration_pct: 85,
    deployer_holdings_pct: 30,
    lp_locked_heuristic: false,
    flags: ['high_concentration', 'deployer_holds_large'],
  };
}

type Helpers = ReportRouterHelpers;

function makeApp(helpers: Partial<Helpers>) {
  const full: Helpers = {
    market: async () => marketOk(),
    honeypot: async () => honeypotClean(),
    forensics: async () => forensicsClean(),
    ...helpers,
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/x402/base',
    createReportRouter({
      dexScreener: { getTokenPools: async () => [] },
      honeypot: { checkToken: async () => ({}) },
      blockscout: {
        getToken: async () => ({}),
        getTokenHolders: async () => ({ items: [] }),
        getAddress: async () => ({}),
      },
      helpers: full,
    }),
  );
  return app;
}

describe('GET /api/v1/x402/base/token/:address/report', () => {
  it('returns 400 on invalid address', async () => {
    const app = makeApp({});
    const res = await request(app).get('/api/v1/x402/base/token/not-an-address/report');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_address' });
  });

  it('all happy, clean → level=clean', async () => {
    const app = makeApp({});
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(VALID);
    expect(res.body.chain).toBe('base');
    expect(res.body.market.address).toBe(VALID);
    expect(res.body.honeypot.is_honeypot).toBe(false);
    expect(res.body.forensics.lp_locked_heuristic).toBe(true);
    // lp_locked subtracts 1; clean honeypot; moderate top10 → score ≤ 2 → 'clean'
    expect(res.body.risk.level).toBe('clean');
    expect(typeof res.body.generated_at).toBe('string');
  });

  it('honeypot-positive + bad forensics → high risk and correct flags', async () => {
    const app = makeApp({
      honeypot: async () => honeypotBad(),
      forensics: async () => forensicsHot(),
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    expect(res.body.risk.flags).toEqual(
      expect.arrayContaining([
        'honeypot_detected',
        'high_tax',
        'high_concentration',
        'deployer_holds_large',
      ]),
    );
    expect(['risky', 'critical']).toContain(res.body.risk.level);
    expect(res.body.risk.score).toBeGreaterThanOrEqual(7);
  });

  it('one section fails → 200 with that section marked unavailable; risk computed from rest', async () => {
    const app = makeApp({
      market: async () => marketOk(),
      honeypot: async () => {
        throw new Error('honeypot mcp down');
      },
      forensics: async () => forensicsHot(),
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    expect(res.body.honeypot).toEqual({ available: false, error: 'upstream_failure' });
    expect(res.body.market.address).toBe(VALID);
    expect(res.body.forensics.address).toBe(VALID);
    expect(res.body.risk.flags).toEqual(expect.arrayContaining(['high_concentration']));
    expect(res.body.risk.flags).not.toContain('honeypot_detected');
  });

  it('all three fail → 502 all_upstream_failed', async () => {
    const app = makeApp({
      market: async () => {
        throw new Error('m');
      },
      honeypot: async () => {
        throw new Error('h');
      },
      forensics: async () => {
        throw new Error('f');
      },
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'all_upstream_failed' });
  });

  it('passes top_pool.pair_address from market through to forensics', async () => {
    const forensicsSpy = vi.fn(async () => forensicsClean());
    const app = makeApp({
      market: async () => marketOk(),
      forensics: forensicsSpy,
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    expect(forensicsSpy).toHaveBeenCalledTimes(1);
    const callArgs = forensicsSpy.mock.calls[0];
    expect(callArgs?.[1]).toBe(VALID);
    expect(callArgs?.[2]).toBe(PAIR);
  });

  it('when market fails, forensics is called with pair=null', async () => {
    const forensicsSpy = vi.fn(async () => forensicsClean());
    const app = makeApp({
      market: async () => {
        throw new Error('no market');
      },
      forensics: forensicsSpy,
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    const callArgs = forensicsSpy.mock.calls[0];
    expect(callArgs?.[2]).toBeNull();
  });
});
