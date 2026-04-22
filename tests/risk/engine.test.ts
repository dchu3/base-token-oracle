import { describe, it, expect } from 'vitest';
import { computeRisk } from '../../src/risk/engine.js';

describe('computeRisk', () => {
  it('returns clean with empty inputs', () => {
    const r = computeRisk({});
    expect(r).toEqual({ score: 0, level: 'clean', flags: [] });
  });

  it('adds +4 for honeypot detection', () => {
    const r = computeRisk({ honeypot: { is_honeypot: true } });
    expect(r.score).toBe(4);
    expect(r.flags).toContain('honeypot_detected');
    expect(r.level).toBe('caution');
  });

  it('does not flag honeypot when is_honeypot is false', () => {
    const r = computeRisk({ honeypot: { is_honeypot: false } });
    expect(r.score).toBe(0);
    expect(r.flags).not.toContain('honeypot_detected');
    expect(r.level).toBe('clean');
  });

  it('adds +2 when buy_tax > 10', () => {
    const r = computeRisk({ honeypot: { is_honeypot: false, buy_tax: 11 } });
    expect(r.score).toBe(2);
    expect(r.flags).toContain('high_tax');
  });

  it('adds +2 when sell_tax > 10', () => {
    const r = computeRisk({ honeypot: { is_honeypot: false, sell_tax: 25 } });
    expect(r.score).toBe(2);
    expect(r.flags).toContain('high_tax');
  });

  it('does not flag high_tax when taxes are exactly 10', () => {
    const r = computeRisk({ honeypot: { is_honeypot: false, buy_tax: 10, sell_tax: 10 } });
    expect(r.flags).not.toContain('high_tax');
    expect(r.score).toBe(0);
  });

  it('adds +2 when top10_concentration_pct > 70', () => {
    const r = computeRisk({ forensics: { top10_concentration_pct: 71 } });
    expect(r.score).toBe(2);
    expect(r.flags).toContain('high_concentration');
  });

  it('does not flag high_concentration at exactly 70', () => {
    const r = computeRisk({ forensics: { top10_concentration_pct: 70 } });
    expect(r.flags).not.toContain('high_concentration');
  });

  it('adds +1 when deployer_holdings_pct > 20', () => {
    const r = computeRisk({ forensics: { deployer_holdings_pct: 21 } });
    expect(r.score).toBe(1);
    expect(r.flags).toContain('deployer_holds_large');
  });

  it('adds +1 when liquidity_usd < 10000', () => {
    const r = computeRisk({ market: { liquidity_usd: 9999 } });
    expect(r.score).toBe(1);
    expect(r.flags).toContain('low_liquidity');
  });

  it('does not flag low_liquidity at exactly 10000', () => {
    const r = computeRisk({ market: { liquidity_usd: 10000 } });
    expect(r.flags).not.toContain('low_liquidity');
  });

  it('adds +1 when pair_age_hours < 24', () => {
    const r = computeRisk({ market: { pair_age_hours: 23 } });
    expect(r.score).toBe(1);
    expect(r.flags).toContain('new_pair');
  });

  it('does not flag new_pair at exactly 24h', () => {
    const r = computeRisk({ market: { pair_age_hours: 24 } });
    expect(r.flags).not.toContain('new_pair');
  });

  it('subtracts 1 when lp_locked is true', () => {
    const r = computeRisk({
      forensics: { lp_locked: true, top10_concentration_pct: 71 },
    });
    // +2 high_concentration -1 lp_locked = 1
    expect(r.score).toBe(1);
    expect(r.flags).toContain('lp_locked');
    expect(r.flags).toContain('high_concentration');
  });

  it('clamps final score to [0, 10]', () => {
    const ultra = computeRisk({
      honeypot: { is_honeypot: true, buy_tax: 50, sell_tax: 50 },
      forensics: { top10_concentration_pct: 99, deployer_holdings_pct: 99, lp_locked: false },
      market: { liquidity_usd: 100, pair_age_hours: 1 },
    });
    // 4 + 2 + 2 + 1 + 1 + 1 = 11 → clamp to 10
    expect(ultra.score).toBe(10);
    expect(ultra.level).toBe('critical');
  });

  it('clamps negative score to 0 when only lp_locked present', () => {
    const r = computeRisk({ forensics: { lp_locked: true } });
    expect(r.score).toBe(0);
    expect(r.level).toBe('clean');
    expect(r.flags).toContain('lp_locked');
  });

  it('maps level thresholds correctly', () => {
    expect(computeRisk({}).level).toBe('clean'); // 0
    expect(computeRisk({ market: { liquidity_usd: 1, pair_age_hours: 1 } }).level).toBe('clean'); // 2
    expect(computeRisk({ honeypot: { is_honeypot: true } }).level).toBe('caution'); // 4
    // 6 → risky: honeypot +4, high_tax +2
    expect(
      computeRisk({ honeypot: { is_honeypot: true, buy_tax: 20 } }).level,
    ).toBe('risky');
    // 9 → critical: honeypot +4, high_tax +2, high_concentration +2, deployer +1
    expect(
      computeRisk({
        honeypot: { is_honeypot: true, buy_tax: 20 },
        forensics: { top10_concentration_pct: 90, deployer_holdings_pct: 30 },
      }).level,
    ).toBe('critical');
  });

  it('combined realistic scenario', () => {
    const r = computeRisk({
      honeypot: { is_honeypot: false, buy_tax: 5, sell_tax: 15 },
      forensics: { top10_concentration_pct: 80, deployer_holdings_pct: 25, lp_locked: true },
      market: { liquidity_usd: 5000, pair_age_hours: 12 },
    });
    // high_tax +2, high_concentration +2, deployer +1, low_liquidity +1, new_pair +1, lp_locked -1 = 6
    expect(r.score).toBe(6);
    expect(r.level).toBe('risky');
    expect(r.flags.sort()).toEqual(
      [
        'high_tax',
        'high_concentration',
        'deployer_holds_large',
        'low_liquidity',
        'new_pair',
        'lp_locked',
      ].sort(),
    );
  });
});
