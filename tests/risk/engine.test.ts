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
  });

  it('clamps score at 0', () => {
    const res = computeRisk({
      top10ConcentrationPct: 10,
      deployerHoldingsPct: 0,
      verified: true,
      lpLocked: true, // 0 - 1 = -1 -> clamped to 0
    });
    expect(res.score).toBe(0);
  });

  it('reaches risky/critical levels with multiple flags', () => {
    // This will currently max out at 4 with current Blockscout-only logic
    // +2 (concentration) +1 (deployer) +1 (unverified) = 4 (caution)
    // To test risky/critical we can use the "future" fields in the test
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
  });
});
