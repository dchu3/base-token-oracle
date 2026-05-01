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

  describe('single-threshold rules (back-compat with prior engine)', () => {
    it('concentration: > 70 → +2, ≤ 70 → 0', () => {
      expect(
        computeRisk({
          top10ConcentrationPct: 71,
          deployerHoldingsPct: 0,
          verified: true,
          lpLocked: false,
        }).score,
      ).toBe(2);
      // 70 is the boundary — strict > so 70 itself is clean
      expect(
        computeRisk({
          top10ConcentrationPct: 70,
          deployerHoldingsPct: 0,
          verified: true,
          lpLocked: false,
        }).score,
      ).toBe(0);
      // values that previously scored 0 stay at 0 (back-compat)
      expect(
        computeRisk({
          top10ConcentrationPct: 60,
          deployerHoldingsPct: 0,
          verified: true,
          lpLocked: false,
        }).score,
      ).toBe(0);
    });

    it('deployer: > 20 → +1, ≤ 20 → 0 (no intermediate tier)', () => {
      const moderate = computeRisk({
        top10ConcentrationPct: 0,
        deployerHoldingsPct: 15,
        verified: true,
        lpLocked: false,
      });
      expect(moderate.score).toBe(0);
      expect(moderate.flags).toEqual([]);
    });

    it('tax: > 10 → +2, ≤ 10 → 0; uses max(buy,sell)', () => {
      // 7% (previously 0 in the elevated_tax tier) stays 0 for back-compat
      expect(
        computeRisk({
          top10ConcentrationPct: 0,
          deployerHoldingsPct: 0,
          verified: true,
          lpLocked: false,
          buyTaxPct: 7,
        }).score,
      ).toBe(0);
      // both high → still capped at the rule's max (+2), not doubled
      expect(
        computeRisk({
          top10ConcentrationPct: 0,
          deployerHoldingsPct: 0,
          verified: true,
          lpLocked: false,
          buyTaxPct: 25,
          sellTaxPct: 30,
        }).score,
      ).toBe(2);
    });

    it('liquidity: < 10k → +1, ≥ 10k → 0', () => {
      expect(
        computeRisk({
          top10ConcentrationPct: 0,
          deployerHoldingsPct: 0,
          verified: true,
          lpLocked: false,
          liquidityUsd: 25_000,
        }).score,
      ).toBe(0);
      const low = computeRisk({
        top10ConcentrationPct: 0,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
        liquidityUsd: 5_000,
      });
      expect(low.flags).toContain('low_liquidity');
      expect(low.score).toBe(1);
    });

    it('pair age: < 24h → +1, ≥ 24h → 0', () => {
      expect(
        computeRisk({
          top10ConcentrationPct: 0,
          deployerHoldingsPct: 0,
          verified: true,
          lpLocked: false,
          pairAgeHours: 48,
        }).score,
      ).toBe(0);
      const fresh = computeRisk({
        top10ConcentrationPct: 0,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
        pairAgeHours: 1,
      });
      expect(fresh.flags).toContain('new_pair');
      expect(fresh.score).toBe(1);
    });
  });

  describe('coverage and confidence', () => {
    it('marks all rules missing when every input is null/undefined', () => {
      const res = computeRisk({
        top10ConcentrationPct: null,
        deployerHoldingsPct: null,
        verified: null,
        lpLocked: null,
      });
      expect(res.score).toBe(0);
      expect(res.coverage.evaluated).toBe(0);
      expect(res.coverage.total).toBe(8);
      expect(res.coverage.missing).toEqual(
        expect.arrayContaining([
          'honeypot_detected',
          'high_tax',
          'high_concentration',
          'deployer_holds_large',
          'unverified_contract',
          'low_liquidity',
          'new_pair',
          'lp_locked',
        ]),
      );
      expect(res.confidence).toBe('low');
    });

    it('treats undefined the same as null for concentration/deployer/verified', () => {
      const res = computeRisk({
        top10ConcentrationPct: undefined as unknown as number | null,
        deployerHoldingsPct: undefined as unknown as number | null,
        verified: undefined as unknown as boolean | null,
        lpLocked: undefined as unknown as boolean | null,
      });
      expect(res.coverage.evaluated).toBe(0);
      expect(res.coverage.missing).toEqual(
        expect.arrayContaining([
          'high_concentration',
          'deployer_holds_large',
          'unverified_contract',
          'lp_locked',
        ]),
      );
    });

    it('reports medium confidence when only forensics inputs present', () => {
      const res = computeRisk({
        top10ConcentrationPct: 10,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
      });
      // 4 of 8 rules evaluable → 50% → medium
      expect(res.coverage.evaluated).toBe(4);
      expect(res.confidence).toBe('medium');
    });

    it('reports medium at exactly 5/8 (just below 0.75 high threshold)', () => {
      const res = computeRisk({
        top10ConcentrationPct: 10,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
        isHoneypot: false,
      });
      expect(res.coverage.evaluated).toBe(5);
      expect(res.confidence).toBe('medium');
    });

    it('reports high at exactly 6/8 = 0.75 threshold', () => {
      const res = computeRisk({
        top10ConcentrationPct: 10,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
        isHoneypot: false,
        buyTaxPct: 0,
      });
      expect(res.coverage.evaluated).toBe(6);
      expect(res.confidence).toBe('high');
    });

    it('reports high confidence when ≥6/8 inputs are present', () => {
      const res = computeRisk({
        top10ConcentrationPct: 10,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
        isHoneypot: false,
        buyTaxPct: 0,
        liquidityUsd: 1_000_000,
      });
      // 7/8 rules evaluable → high
      expect(res.coverage.evaluated).toBe(7);
      expect(res.confidence).toBe('high');
    });
  });

  describe('mitigants and components', () => {
    it('lp_locked appears in both flags and mitigants and is marked on the component', () => {
      const res = computeRisk({
        top10ConcentrationPct: 80,
        deployerHoldingsPct: 0,
        verified: false,
        lpLocked: true,
      });
      expect(res.flags).toContain('lp_locked');
      expect(res.mitigants).toEqual(['lp_locked']);
      const lp = res.components.find((c) => c.id === 'lp_locked');
      expect(lp?.isMitigant).toBe(true);
      expect(lp?.points).toBe(-1);
    });

    it('component order is deterministic and matches registry order', () => {
      const res = computeRisk({
        top10ConcentrationPct: 80,
        deployerHoldingsPct: 30,
        verified: false,
        lpLocked: true,
        isHoneypot: true,
        buyTaxPct: 15,
      });
      const ids = res.components.map((c) => c.id);
      // Registry order: honeypot, tax, concentration, deployer, verified, ..., lp_locked
      expect(ids[0]).toBe('honeypot_detected');
      expect(ids[1]).toBe('high_tax');
      expect(ids[2]).toBe('high_concentration');
      expect(ids[3]).toBe('deployer_holds_large');
      expect(ids[4]).toBe('unverified_contract');
      expect(ids[ids.length - 1]).toBe('lp_locked');
    });

    it('honeypot alone scores 4 and maps to caution (boundary preserved)', () => {
      const res = computeRisk({
        top10ConcentrationPct: 0,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
        isHoneypot: true,
      });
      expect(res.score).toBe(4);
      expect(res.level).toBe('caution');
    });
  });

  describe('level boundaries', () => {
    it('score 2 = clean, 3 = caution', () => {
      // 80% concentration (+2) → 2
      const a = computeRisk({
        top10ConcentrationPct: 80,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
      });
      expect(a.score).toBe(2);
      expect(a.level).toBe('clean');
      // +2 +1 → 3
      const b = computeRisk({
        top10ConcentrationPct: 80,
        deployerHoldingsPct: 0,
        verified: false,
        lpLocked: false,
      });
      expect(b.score).toBe(3);
      expect(b.level).toBe('caution');
    });

    it('score 5 = caution, 6 = risky', () => {
      // 4 + 1 = 5 (honeypot + unverified)
      const a = computeRisk({
        top10ConcentrationPct: 0,
        deployerHoldingsPct: 0,
        verified: false, // +1
        lpLocked: false,
        isHoneypot: true, // +4
      });
      expect(a.score).toBe(5);
      expect(a.level).toBe('caution');
      // 4 + 1 + 1 = 6 (honeypot + unverified + deployer)
      const b = computeRisk({
        top10ConcentrationPct: 0,
        deployerHoldingsPct: 30, // +1
        verified: false, // +1
        lpLocked: false,
        isHoneypot: true, // +4
      });
      expect(b.score).toBe(6);
      expect(b.level).toBe('risky');
    });

    it('score 8 = risky, 9 = critical', () => {
      // 4 + 2 + 1 + 1 = 8
      const a = computeRisk({
        top10ConcentrationPct: 80, // +2
        deployerHoldingsPct: 30, // +1
        verified: false, // +1
        lpLocked: false,
        isHoneypot: true, // +4
      });
      expect(a.score).toBe(8);
      expect(a.level).toBe('risky');
      // 4 + 2 + 2 + 1 = 9 (honeypot + concentration + tax + unverified)
      const b = computeRisk({
        top10ConcentrationPct: 80, // +2
        deployerHoldingsPct: 0,
        verified: false, // +1
        lpLocked: false,
        isHoneypot: true, // +4
        buyTaxPct: 25, // +2
      });
      expect(b.score).toBe(9);
      expect(b.level).toBe('critical');
    });
  });
});
