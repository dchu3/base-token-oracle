import { describe, it, expect } from 'vitest';
import { computeFlags } from '../../src/services/flags.js';

describe('computeFlags', () => {
  it('returns no flags for clean inputs', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: 10,
        deployerHoldingsPct: 0,
        verified: true,
        lpLocked: false,
      }),
    ).toEqual([]);
  });

  it('emits high_concentration when top10 > 70', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: 70.1,
        deployerHoldingsPct: null,
        verified: null,
        lpLocked: null,
      }),
    ).toEqual(['high_concentration']);
  });

  it('does not emit high_concentration at threshold (=70)', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: 70,
        deployerHoldingsPct: null,
        verified: null,
        lpLocked: null,
      }),
    ).toEqual([]);
  });

  it('emits deployer_holds_large when deployer > 20', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: null,
        deployerHoldingsPct: 20.5,
        verified: null,
        lpLocked: null,
      }),
    ).toEqual(['deployer_holds_large']);
  });

  it('emits unverified_contract only when verified === false', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: null,
        deployerHoldingsPct: null,
        verified: false,
        lpLocked: null,
      }),
    ).toEqual(['unverified_contract']);
    expect(
      computeFlags({
        top10ConcentrationPct: null,
        deployerHoldingsPct: null,
        verified: null,
        lpLocked: null,
      }),
    ).toEqual([]);
  });

  it('emits lp_locked only when lpLocked === true', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: null,
        deployerHoldingsPct: null,
        verified: null,
        lpLocked: true,
      }),
    ).toEqual(['lp_locked']);
    expect(
      computeFlags({
        top10ConcentrationPct: null,
        deployerHoldingsPct: null,
        verified: null,
        lpLocked: false,
      }),
    ).toEqual([]);
  });

  it('emits flags in deterministic order across all triggers', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: 95,
        deployerHoldingsPct: 50,
        verified: false,
        lpLocked: true,
      }),
    ).toEqual(['high_concentration', 'deployer_holds_large', 'unverified_contract', 'lp_locked']);
  });

  it('treats null/undefined inputs as no signal (no flag)', () => {
    expect(
      computeFlags({
        top10ConcentrationPct: null,
        deployerHoldingsPct: null,
        verified: null,
        lpLocked: null,
      }),
    ).toEqual([]);
  });
});
