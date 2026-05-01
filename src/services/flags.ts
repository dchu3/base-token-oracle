import { z } from 'zod';

/**
 * Descriptive attribute flags emitted by `/report`. These are factual
 * tags derived directly from Blockscout-sourced inputs — they are NOT
 * weighted, scored, or aggregated into a level. Consumers decide what
 * (if anything) each flag means for them.
 */
export const FLAG_VALUES = [
  'high_concentration',
  'deployer_holds_large',
  'unverified_contract',
  'lp_locked',
] as const;

export const FlagSchema = z.enum(FLAG_VALUES);
export type Flag = z.infer<typeof FlagSchema>;

export interface FlagInput {
  /**
   * Top-10 holder concentration as a percentage. Callers should pass the
   * *circulating-supply-adjusted* figure (excluding burn + bridge balances)
   * when available so that healthy tokens with most supply locked in burn
   * sinks or canonical bridges aren't misflagged. Falls back to the raw
   * percentage when the adjusted value can't be computed.
   */
  top10ConcentrationPct: number | null;
  /** Deployer wallet's balance as a percentage of total supply. */
  deployerHoldingsPct: number | null;
  /** Whether the contract source is verified on Blockscout. */
  verified: boolean | null;
  /** Whether the LP token's top holder is a known burn/dead address. */
  lpLocked: boolean | null;
}

/**
 * Thresholds used to emit each flag. Inputs that are `null`/`undefined`
 * never produce a flag (no scoring, no "missing" placeholder).
 */
export const FLAG_THRESHOLDS = {
  TOP10_CONCENTRATION_PCT: 70,
  DEPLOYER_HOLDINGS_PCT: 20,
} as const;

export function computeFlags(input: FlagInput): Flag[] {
  const out: Flag[] = [];
  if (
    typeof input.top10ConcentrationPct === 'number' &&
    input.top10ConcentrationPct > FLAG_THRESHOLDS.TOP10_CONCENTRATION_PCT
  ) {
    out.push('high_concentration');
  }
  if (
    typeof input.deployerHoldingsPct === 'number' &&
    input.deployerHoldingsPct > FLAG_THRESHOLDS.DEPLOYER_HOLDINGS_PCT
  ) {
    out.push('deployer_holds_large');
  }
  if (input.verified === false) {
    out.push('unverified_contract');
  }
  if (input.lpLocked === true) {
    out.push('lp_locked');
  }
  return out;
}
