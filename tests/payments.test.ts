import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { applyX402, type PaymentConfig } from '../src/payments.js';
import type { FacilitatorClient } from '@x402/core/server';
import { McpManager } from '../src/mcp/index.js';
import type { BlockscoutToken } from '../src/mcp/index.js';

const VALID = '0x1111111111111111111111111111111111111111';

function stubToken(): BlockscoutToken {
  return {
    address: VALID,
    name: 'Test',
    symbol: 'TST',
    decimals: '18',
    total_supply: '1000',
    type: 'ERC-20',
  };
}

function stubMcp(): McpManager {
  const blockscout = {
    getToken: async () => stubToken(),
    getTokenHolders: async () => ({ items: [] }),
    getAddress: async () => ({ hash: VALID, is_contract: true }),
  };
  const mgr = Object.create(McpManager.prototype) as McpManager;
  Object.defineProperty(mgr, 'blockscout', { value: blockscout });
  return mgr;
}

function mockFacilitator(): FacilitatorClient {
  return {
    verify: async () => ({ isValid: true, invalidReason: undefined } as unknown as Awaited<
      ReturnType<FacilitatorClient['verify']>
    >),
    settle: async () =>
      ({ success: true, transaction: '0xdeadbeef', network: 'eip155:8453' } as unknown as Awaited<
        ReturnType<FacilitatorClient['settle']>
      >),
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' as const }],
      extensions: [],
      signers: {},
    }),
  };
}

function paymentsConfig(
  overrides: Partial<PaymentConfig> = {},
): PaymentConfig {
  return {
    receivingAddress: '0x2222222222222222222222222222222222222222',
    facilitatorUrl: 'https://mock.test/facilitator',
    prices: { report: '0.01' },
    syncFacilitatorOnStart: true,
    facilitatorClient: mockFacilitator(),
    ...overrides,
  };
}

describe('x402 payments middleware', () => {
  it('without payments wired, GET /report returns 200 (free mode)', async () => {
    const app = createApp({ mcp: stubMcp() });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(VALID);

    const health = await request(app).get('/healthz');
    expect(health.body).toEqual({ ok: true, x402: false });
  });

  it('with payments wired and no X-PAYMENT/PAYMENT-SIGNATURE header, returns 402', async () => {
    const app = createApp({ mcp: stubMcp(), payments: paymentsConfig() });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(402);
    expect(res.headers['payment-required']).toBeDefined();

    const health = await request(app).get('/healthz');
    expect(health.body).toEqual({ ok: true, x402: true });
  });

  it('with payments wired + granted-access hook, route executes and returns 200', async () => {
    const facilitatorVerify = vi.fn();
    const fac: FacilitatorClient = {
      ...mockFacilitator(),
      verify: facilitatorVerify,
    };
    const app = createApp({
      mcp: stubMcp(),
      payments: paymentsConfig({
        facilitatorClient: fac,
        protectedRequestHook: async () => ({ grantAccess: true }),
      }),
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(VALID);
    expect(facilitatorVerify).not.toHaveBeenCalled();
  });

  it('applyX402 can be used standalone against a fresh Express app', async () => {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    applyX402(
      app,
      paymentsConfig({
        protectedRequestHook: async () => ({ grantAccess: true }),
      }),
    );
    app.get('/api/v1/x402/base/token/:address/report', (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app).get(`/api/v1/x402/base/token/${VALID}/report`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
