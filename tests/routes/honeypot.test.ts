import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createHoneypotRouter,
  type HoneypotCheckService,
} from '../../src/routes/honeypot.js';
import type { HoneypotCheck } from '../../src/mcp/honeypot.js';

function makeApp(service: HoneypotCheckService) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/x402/base', createHoneypotRouter({ honeypot: service }));
  return app;
}

const VALID_ADDRESS = '0x4200000000000000000000000000000000000006';

const honeypotNegativeUpstream: HoneypotCheck = {
  summary: { verdict: 'SAFE_TO_TRADE', reason: 'Safe to trade' },
  taxes: { buyBps: 100, sellBps: 150, transferBps: 0 },
  flags: { isHoneypot: false, simulationSuccess: true },
  risk: { description: 'Low risk' },
} as unknown as HoneypotCheck;

const honeypotPositiveUpstream: HoneypotCheck = {
  summary: { verdict: 'DO_NOT_TRADE', reason: 'Cannot sell' },
  taxes: { buyBps: 500, sellBps: 9900, transferBps: 0 },
  flags: { isHoneypot: true, simulationSuccess: false },
  risk: { description: 'Honeypot detected' },
} as unknown as HoneypotCheck;

describe('GET /api/v1/x402/base/token/:address/honeypot', () => {
  it('returns 400 for invalid address', async () => {
    const service: HoneypotCheckService = {
      checkToken: vi.fn(),
    };
    const res = await request(makeApp(service)).get(
      '/api/v1/x402/base/token/0xnothex/honeypot',
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_address' });
    expect(service.checkToken).not.toHaveBeenCalled();
  });

  it('returns 200 with is_honeypot=true and correct flags for honeypot fixture', async () => {
    const service: HoneypotCheckService = {
      checkToken: vi.fn().mockResolvedValue(honeypotPositiveUpstream),
    };
    const res = await request(makeApp(service)).get(
      `/api/v1/x402/base/token/${VALID_ADDRESS}/honeypot`,
    );
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(VALID_ADDRESS);
    expect(res.body.chain).toBe('base');
    expect(res.body.is_honeypot).toBe(true);
    expect(res.body.buy_tax).toBe(5);
    expect(res.body.sell_tax).toBe(99);
    expect(res.body.transfer_tax).toBe(0);
    expect(res.body.simulation_success).toBe(false);
    expect(res.body.honeypot_reason).toBe('Cannot sell');
    expect(res.body.flags).toEqual(
      expect.arrayContaining([
        'honeypot',
        'simulation_failed',
        'high_sell_tax',
      ]),
    );
    expect(res.body.flags).not.toContain('high_buy_tax');
    expect(service.checkToken).toHaveBeenCalledWith({
      address: VALID_ADDRESS,
      chain: 'base',
    });
  });

  it('returns 200 with is_honeypot=false for clean token', async () => {
    const service: HoneypotCheckService = {
      checkToken: vi.fn().mockResolvedValue(honeypotNegativeUpstream),
    };
    const res = await request(makeApp(service)).get(
      `/api/v1/x402/base/token/${VALID_ADDRESS}/honeypot`,
    );
    expect(res.status).toBe(200);
    expect(res.body.is_honeypot).toBe(false);
    expect(res.body.buy_tax).toBe(1);
    expect(res.body.sell_tax).toBe(1.5);
    expect(res.body.transfer_tax).toBe(0);
    expect(res.body.simulation_success).toBe(true);
    expect(res.body.flags).toEqual([]);
  });

  it('returns 502 on upstream throw', async () => {
    const service: HoneypotCheckService = {
      checkToken: vi.fn().mockRejectedValue(new Error('mcp crashed')),
    };
    const res = await request(makeApp(service)).get(
      `/api/v1/x402/base/token/${VALID_ADDRESS}/honeypot`,
    );
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'upstream_failure' });
  });

  it('returns 404 when upstream says token not analyzable', async () => {
    const service: HoneypotCheckService = {
      checkToken: vi
        .fn()
        .mockRejectedValue(new Error('no pair found for token')),
    };
    const res = await request(makeApp(service)).get(
      `/api/v1/x402/base/token/${VALID_ADDRESS}/honeypot`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('token_not_analyzable');
    expect(res.body.detail).toMatch(/no pair/i);
  });

  it('emits null fields when upstream omits data', async () => {
    const service: HoneypotCheckService = {
      checkToken: vi.fn().mockResolvedValue({} as HoneypotCheck),
    };
    const res = await request(makeApp(service)).get(
      `/api/v1/x402/base/token/${VALID_ADDRESS}/honeypot`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      address: VALID_ADDRESS,
      chain: 'base',
      is_honeypot: null,
      buy_tax: null,
      sell_tax: null,
      transfer_tax: null,
      simulation_success: null,
      honeypot_reason: null,
      flags: [],
    });
  });
});
