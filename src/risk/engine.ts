import { z } from 'zod';

export const RiskLevelSchema = z.enum(['clean', 'caution', 'risky', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export interface RiskInput {
  // Blockscout forensics
  top10ConcentrationPct: number | null;
  deployerHoldingsPct: number | null;
  verified: boolean | null;
  lpLocked: boolean | null;
  
  // Placeholders for future MCP integrations
  isHoneypot?: boolean | null;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  liquidityUsd?: number | null;
  pairAgeHours?: number | null;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  flags: string[];
}

export const RISK_THRESHOLDS = {
  CLEAN: 2,
  CAUTION: 5,
  RISKY: 8,
};

/**
 * Deterministic risk scoring engine.
 * 
 * Rules (clamped to 0-10):
 * - +4 if honeypot detected (future)
 * - +2 if buy/sell tax > 10% (future)
 * - +2 if top-10 holder concentration > 70%
 * - +1 if deployer holds > 20%
 * - +1 if unverified contract
 * - +1 if liquidity < $10k (future)
 * - +1 if pair < 24 hours old (future)
 * - -1 if LP is locked (reduces risk)
 * 
 * Mapping:
 * - 0–2 = clean
 * - 3–5 = caution
 * - 6–8 = risky
 * - 9–10 = critical
 */
export function computeRisk(input: RiskInput): RiskResult {
  let score = 0;
  const flags: string[] = [];

  // Honeypot (future)
  if (input.isHoneypot === true) {
    score += 4;
    flags.push('honeypot_detected');
  }

  // Taxes (future)
  if ((input.buyTaxPct ?? 0) > 10 || (input.sellTaxPct ?? 0) > 10) {
    score += 2;
    flags.push('high_tax');
  }

  // Concentration
  if (input.top10ConcentrationPct !== null && input.top10ConcentrationPct > 70) {
    score += 2;
    flags.push('high_concentration');
  }

  // Deployer holdings
  if (input.deployerHoldingsPct !== null && input.deployerHoldingsPct > 20) {
    score += 1;
    flags.push('deployer_holds_large');
  }

  // Verification
  if (input.verified === false) {
    score += 1;
    flags.push('unverified_contract');
  }

  // Liquidity (future)
  if (input.liquidityUsd !== undefined && input.liquidityUsd !== null && input.liquidityUsd < 10000) {
    score += 1;
    flags.push('low_liquidity');
  }

  // Pair age (future)
  if (input.pairAgeHours !== undefined && input.pairAgeHours !== null && input.pairAgeHours < 24) {
    score += 1;
    flags.push('new_pair');
  }

  // LP Locked (Mitigant)
  if (input.lpLocked === true) {
    score -= 1;
    flags.push('lp_locked');
  }

  // Clamp and finalize
  const finalScore = Math.max(0, Math.min(10, score));
  
  return {
    score: finalScore,
    level: mapScoreToLevel(finalScore),
    flags,
  };
}

function mapScoreToLevel(score: number): RiskLevel {
  if (score <= RISK_THRESHOLDS.CLEAN) return 'clean';
  if (score <= RISK_THRESHOLDS.CAUTION) return 'caution';
  if (score <= RISK_THRESHOLDS.RISKY) return 'risky';
  return 'critical';
}
