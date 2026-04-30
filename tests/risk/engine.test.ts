import { describe, it, expect } from 'vitest';
import { computeRisk } from '../../src/risk/engine.js';

describe('Risk Engine', () => {
  it('returns clean (0) for perfect tokens', () => {
    const res = computeRisk({
      top10ConcentrationPct: 10,
      deployerHoldingsPct: 0,
      verified: true,
      lpLocked: false,
    });
    expect(res.score).toBe(0);
    expect(res.level).toBe('clean');
    expect(res.flags).toHaveLength(0);
  });

  it('penalizes high concentration and unverified contracts', () => {
    const res = computeRisk({
      top10ConcentrationPct: 80, // +2
      deployerHoldingsPct: 0,
      verified: false, // +1
      lpLocked: false,
    });
    expect(res.score).toBe(3);
    expect(res.level).toBe('caution');
    expect(res.flags).toContain('high_concentration');
    expect(res.flags).toContain('unverified_contract');
  });

  it('penalizes large deployer holdings', () => {
    const res = computeRisk({
      top10ConcentrationPct: 50,
      deployerHoldingsPct: 30, // +1
      verified: true,
      lpLocked: false,
    });
    expect(res.score).toBe(1);
    expect(res.level).toBe('clean');
    expect(res.flags).toContain('deployer_holds_large');
  });

  it('applies LP lock mitigant', () => {
    const res = computeRisk({
      top10ConcentrationPct: 80, // +2
      deployerHoldingsPct: 0,
      verified: false, // +1
      lpLocked: true, // -1
    });
    expect(res.score).toBe(2);
    expect(res.level).toBe('clean');
    expect(res.flags).toContain('lp_locked');
  });

  it('clamps score at 0', () => {
    const res = computeRisk({
      top10ConcentrationPct: 10,
      deployerHoldingsPct: 0,
      verified: true,
      lpLocked: true, // 0 - 1 = -1 -> clamped to 0
    });
    expect(res.score).toBe(0);
    expect(res.flags).toContain('lp_locked');
  });

  it('reaches risky/critical levels with multiple flags', () => {
    const res = computeRisk({
      top10ConcentrationPct: 80, // +2
      deployerHoldingsPct: 30, // +1
      verified: false, // +1
      lpLocked: false,
      isHoneypot: true, // +4
      buyTaxPct: 15, // +2
    });
    expect(res.score).toBe(10); // 2+1+1+4+2 = 10
    expect(res.level).toBe('critical');
    expect(res.flags).toEqual(
      expect.arrayContaining([
        'high_concentration',
        'deployer_holds_large',
        'unverified_contract',
        'honeypot_detected',
        'high_tax',
      ]),
    );
  });
});
