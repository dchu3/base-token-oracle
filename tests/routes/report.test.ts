import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import {
  createReportRouter,
  type ForensicsBlockscout,
} from '../../src/routes/report.js';
import type {
  BlockscoutAddress,
  BlockscoutAddressTxs,
  BlockscoutHolders,
  BlockscoutToken,
} from '../../src/mcp/blockscout.js';

const TOKEN = '0x1111111111111111111111111111111111111111';
const DEPLOYER = '0x2222222222222222222222222222222222222222';
const WHALE = '0x3333333333333333333333333333333333333333';
const PAIR = '0x4444444444444444444444444444444444444444';
const DEAD = '0x000000000000000000000000000000000000dEaD';

function makeApp(mock: ForensicsBlockscout): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/x402/base', createReportRouter({ blockscout: mock }));
  return app;
}

function mockBlockscout(overrides: Partial<ForensicsBlockscout>): ForensicsBlockscout {
  return {
    getToken: vi.fn(async () => ({}) as BlockscoutToken),
    getTokenHolders: vi.fn(async () => ({ items: [] }) as BlockscoutHolders),
    getAddress: vi.fn(async () => ({}) as BlockscoutAddress),
    getAddressTransactions: vi.fn(async () => ({ items: [] }) as BlockscoutAddressTxs),
    ...overrides,
  };
}

describe('GET /token/:address/report', () => {
  it('rejects invalid addresses with 400', async () => {
    const app = makeApp(mockBlockscout({}));
    const res = await request(app).get('/api/v1/x402/base/token/0xNOPE/report');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_address' });
  });

  it('happy path: computes all fields with deployer enrichment', async () => {
    const totalSupply = 1_000_000n * 10n ** 18n;
    const tokenResp: BlockscoutToken = {
      address: TOKEN,
      name: 'TestCoin',
      symbol: 'TST',
      decimals: '18',
      total_supply: totalSupply.toString(),
      circulating_market_cap: '500000',
      exchange_rate: '0.5',
      type: 'ERC-20',
      holders_count: '1500',
      // creator_address_hash lives in passthrough space on the Zod schema:
      ...({ creator_address_hash: DEPLOYER, is_verified: true } as Record<string, unknown>),
    };
    // Two holders: deployer with 5% and whale with 10%. top10 = 15%.
    const holdersResp: BlockscoutHolders = {
      items: [
        {
          address: { hash: WHALE },
          value: ((totalSupply * 10n) / 100n).toString(),
        },
        {
          address: { hash: DEPLOYER },
          value: ((totalSupply * 5n) / 100n).toString(),
        },
      ],
    };
    const deployerAddrResp: BlockscoutAddress = {
      hash: DEPLOYER,
      is_contract: false,
      coin_balance: '1000',
      creation_tx_hash: '0xcreatetx',
      ...({ transactions_count: 42 } as Record<string, unknown>),
    };

    const tokenTxsResp: BlockscoutAddressTxs = {
      items: [
        { timestamp: '2026-04-29T10:00:00Z', method: 'transfer' },
        { timestamp: '2026-04-29T09:00:00Z', method: 'approve' },
        { timestamp: '2026-04-29T08:00:00Z', method: 'transfer' },
      ],
    };

    const deployerTxsResp: BlockscoutAddressTxs = {
      items: [{ timestamp: '2026-04-29T11:00:00Z', method: null }],
    };

    const getAddress = vi.fn(async () => deployerAddrResp);
    const getAddressTransactions = vi.fn(async (addr: string) => {
      if (addr === TOKEN) return tokenTxsResp;
      if (addr === DEPLOYER.toLowerCase()) return deployerTxsResp;
      return { items: [] };
    });

    const mock = mockBlockscout({
      getToken: vi.fn(async () => tokenResp),
      getTokenHolders: vi.fn(async () => holdersResp),
      getAddress,
      getAddressTransactions,
    });

    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      address: TOKEN,
      chain: 'base',
      token: {
        name: 'TestCoin',
        symbol: 'TST',
        decimals: 18,
        total_supply: totalSupply.toString(),
        circulating_market_cap: '500000',
        exchange_rate: '0.5',
        type: 'ERC-20',
        verified: true,
      },
      deployer: {
        address: DEPLOYER.toLowerCase(),
        is_contract: false,
        tx_count: 42,
        coin_balance: '1000',
        creation_tx_hash: '0xcreatetx',
        last_active_timestamp: '2026-04-29T11:00:00Z',
      },
      token_activity: {
        last_active_timestamp: '2026-04-29T10:00:00Z',
        recent_methods: ['transfer', 'approve'],
      },
      holder_count: 1500,
      top10_concentration_pct: 15,
      deployer_holdings_pct: 5,
      lp_locked_heuristic: null,
      flags: [],
    });
    expect(getAddress).toHaveBeenCalledWith(DEPLOYER.toLowerCase(), 'base');
  });

  it('missing deployer: no creator resolvable → deployer null and deployer_holdings_pct null', async () => {
    const totalSupply = 1_000_000n;
    const tokenResp: BlockscoutToken = {
      name: 'NoCreator',
      symbol: 'NC',
      decimals: 18,
      total_supply: totalSupply.toString(),
      type: 'ERC-20',
    };
    const holdersResp: BlockscoutHolders = {
      items: [{ address: { hash: WHALE }, value: (totalSupply / 2n).toString() }],
    };
    // getAddress on the contract yields no creator_address_hash; enrichment never fires.
    const mock = mockBlockscout({
      getToken: vi.fn(async () => tokenResp),
      getTokenHolders: vi.fn(async () => holdersResp),
      getAddress: vi.fn(async () => ({ hash: TOKEN, is_contract: true }) as BlockscoutAddress),
    });

    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.deployer).toBeNull();
    expect(res.body.deployer_holdings_pct).toBeNull();
    expect(res.body.top10_concentration_pct).toBe(50);
  });

  it('triggers high_concentration + deployer_holds_large + unverified_contract flags', async () => {
    const totalSupply = 1_000n;
    const tokenResp: BlockscoutToken = {
      name: 'Risky',
      symbol: 'RSK',
      decimals: 18,
      total_supply: totalSupply.toString(),
      type: 'ERC-20',
      ...({ creator_address_hash: DEPLOYER, is_verified: false } as Record<string, unknown>),
    };
    // Deployer = 80% of supply ⇒ top10 also 80%.
    const holdersResp: BlockscoutHolders = {
      items: [{ address: { hash: DEPLOYER }, value: ((totalSupply * 80n) / 100n).toString() }],
    };
    const mock = mockBlockscout({
      getToken: vi.fn(async () => tokenResp),
      getTokenHolders: vi.fn(async () => holdersResp),
      getAddress: vi.fn(
        async () =>
          ({ hash: DEPLOYER, is_contract: false, ...({ transactions_count: 1 } as Record<string, unknown>) }) as BlockscoutAddress,
      ),
    });

    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.top10_concentration_pct).toBe(80);
    expect(res.body.deployer_holdings_pct).toBe(80);
    expect(res.body.flags).toEqual(
      expect.arrayContaining(['high_concentration', 'deployer_holds_large', 'unverified_contract']),
    );
  });

  it('lp_locked_heuristic true when ?pair has the dead address in top-5 LP holders', async () => {
    const totalSupply = 1_000n;
    const tokenResp: BlockscoutToken = {
      name: 'Paired',
      symbol: 'PRD',
      decimals: 18,
      total_supply: totalSupply.toString(),
      type: 'ERC-20',
    };
    const holdersResp: BlockscoutHolders = {
      items: [{ address: { hash: WHALE }, value: '100' }],
    };
    const pairHoldersResp: BlockscoutHolders = {
      items: [
        { address: { hash: DEAD }, value: '900' },
        { address: { hash: WHALE }, value: '100' },
      ],
    };

    const getTokenHolders = vi.fn(async (addr: string) => {
      if (addr === PAIR) return pairHoldersResp;
      return holdersResp;
    });
    const mock = mockBlockscout({
      getToken: vi.fn(async () => tokenResp),
      getTokenHolders,
      getAddress: vi.fn(async () => ({}) as BlockscoutAddress),
    });

    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report?pair=${PAIR}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.lp_locked_heuristic).toBe(true);
    expect(res.body.flags).toContain('lp_locked');
  });

  it('returns 502 on upstream failure', async () => {
    const mock = mockBlockscout({
      getToken: vi.fn(async () => {
        throw new Error('stdio pipe closed');
      }),
    });
    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('upstream_error');
  });

  it('returns 404 when blockscout reports token not found', async () => {
    const mock = mockBlockscout({
      getToken: vi.fn(async () => {
        throw new Error('MCP tool returned error: Not found');
      }),
    });
    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'token_not_found' });
  });

  it('returns 404 when token response is empty', async () => {
    const mock = mockBlockscout({
      getToken: vi.fn(async () => ({}) as BlockscoutToken),
      getTokenHolders: vi.fn(async () => ({ items: [] }) as BlockscoutHolders),
    });
    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(404);
  });

  it('does not trip high_concentration when supply lives in burn + bridge holders', async () => {
    const totalSupply = 1_000n;
    const BURN = '0x000000000000000000000000000000000000dEaD';
    const BRIDGE = '0x4200000000000000000000000000000000000010';
    const tokenResp: BlockscoutToken = {
      name: 'BridgedCoin',
      symbol: 'BRG',
      decimals: 18,
      total_supply: totalSupply.toString(),
      type: 'ERC-20',
    };
    // Top-10 raw concentration = 80%, but it's all burn (30%) + bridge (50%).
    // Circulating denominator = 1000 - 800 = 200; circulating top-10 = 0%.
    const holdersResp: BlockscoutHolders = {
      items: [
        { address: { hash: BRIDGE }, value: '500' },
        { address: { hash: BURN }, value: '300' },
        { address: { hash: WHALE }, value: '50' },
      ],
    };
    const mock = mockBlockscout({
      getToken: vi.fn(async () => tokenResp),
      getTokenHolders: vi.fn(async () => holdersResp),
      // Whichever address is queried, return is_contract=false so it's an EOA.
      getAddress: vi.fn(async () => ({ is_contract: false }) as BlockscoutAddress),
    });

    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.top10_concentration_pct).toBe(85);
    expect(res.body.circulating_top10_concentration_pct).toBe(25);
    expect(res.body.flags).not.toContain('high_concentration');
    const cats = res.body.top_holders.map((h: { category: string }) => h.category);
    expect(cats).toEqual(expect.arrayContaining(['bridge', 'burn', 'eoa']));
  });

  it('classifies a contract holder (e.g., LP pool) as `contract`, not eoa', async () => {
    const totalSupply = 1_000n;
    const LP = '0x5555555555555555555555555555555555555555';
    const tokenResp: BlockscoutToken = {
      name: 'LpToken',
      symbol: 'LP',
      decimals: 18,
      total_supply: totalSupply.toString(),
      type: 'ERC-20',
    };
    const holdersResp: BlockscoutHolders = {
      items: [{ address: { hash: LP }, value: '800' }],
    };
    const mock = mockBlockscout({
      getToken: vi.fn(async () => tokenResp),
      getTokenHolders: vi.fn(async () => holdersResp),
      getAddress: vi.fn(async () => ({ is_contract: true }) as BlockscoutAddress),
    });

    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.top_holders).toHaveLength(1);
    expect(res.body.top_holders[0]).toMatchObject({
      address: LP,
      percent: 80,
      category: 'contract',
    });
    // contract holders are NOT excluded from circulating supply, so the
    // raw and adjusted figures match.
    expect(res.body.top10_concentration_pct).toBe(80);
    expect(res.body.circulating_top10_concentration_pct).toBe(80);
  });

  it('falls back to `unknown` category when getAddress fails', async () => {
    const totalSupply = 1_000n;
    const tokenResp: BlockscoutToken = {
      name: 'X',
      symbol: 'X',
      decimals: 18,
      total_supply: totalSupply.toString(),
      type: 'ERC-20',
    };
    const holdersResp: BlockscoutHolders = {
      items: [{ address: { hash: WHALE }, value: '100' }],
    };
    const mock = mockBlockscout({
      getToken: vi.fn(async () => tokenResp),
      getTokenHolders: vi.fn(async () => holdersResp),
      getAddress: vi.fn(async () => {
        throw new Error('rpc timeout');
      }),
    });

    const res = await request(makeApp(mock)).get(
      `/api/v1/x402/base/token/${TOKEN}/report`,
    );
    expect(res.status).toBe(200);
    expect(res.body.top_holders[0].category).toBe('unknown');
  });
});

