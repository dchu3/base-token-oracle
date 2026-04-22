export interface RiskInputs {
  honeypot?: {
    is_honeypot: boolean;
    buy_tax?: number;
    sell_tax?: number;
    transfer_tax?: number;
  };
  forensics?: {
    top10_concentration_pct?: number;
    deployer_holdings_pct?: number;
    lp_locked?: boolean;
  };
  market?: {
    liquidity_usd?: number;
    pair_age_hours?: number;
  };
}

export type RiskLevel = 'clean' | 'caution' | 'risky' | 'critical';

export interface RiskOutput {
  score: number;
  level: RiskLevel;
  flags: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function levelFor(score: number): RiskLevel {
  if (score <= 2) return 'clean';
  if (score <= 5) return 'caution';
  if (score <= 8) return 'risky';
  return 'critical';
}

/**
 * Deterministic risk scoring.
 *
 * Rules (all optional inputs are ignored when undefined):
 *  +4 honeypot.is_honeypot === true          → 'honeypot_detected'
 *  +2 buy_tax > 10 OR sell_tax > 10          → 'high_tax'
 *  +2 top10_concentration_pct > 70           → 'high_concentration'
 *  +1 deployer_holdings_pct > 20             → 'deployer_holds_large'
 *  +1 liquidity_usd < 10000                  → 'low_liquidity'
 *  +1 pair_age_hours < 24                    → 'new_pair'
 *  -1 lp_locked === true                     → 'lp_locked'
 *
 * Score is clamped to [0, 10].
 * Level: 0–2 clean, 3–5 caution, 6–8 risky, 9–10 critical.
 */
export function computeRisk(inputs: RiskInputs): RiskOutput {
  const flags: string[] = [];
  let score = 0;

  const { honeypot, forensics, market } = inputs;

  if (honeypot?.is_honeypot === true) {
    score += 4;
    flags.push('honeypot_detected');
  }

  if (honeypot) {
    const { buy_tax, sell_tax } = honeypot;
    if ((buy_tax !== undefined && buy_tax > 10) || (sell_tax !== undefined && sell_tax > 10)) {
      score += 2;
      flags.push('high_tax');
    }
  }

  if (forensics?.top10_concentration_pct !== undefined && forensics.top10_concentration_pct > 70) {
    score += 2;
    flags.push('high_concentration');
  }

  if (forensics?.deployer_holdings_pct !== undefined && forensics.deployer_holdings_pct > 20) {
    score += 1;
    flags.push('deployer_holds_large');
  }

  if (market?.liquidity_usd !== undefined && market.liquidity_usd < 10000) {
    score += 1;
    flags.push('low_liquidity');
  }

  if (market?.pair_age_hours !== undefined && market.pair_age_hours < 24) {
    score += 1;
    flags.push('new_pair');
  }

  if (forensics?.lp_locked === true) {
    score -= 1;
    flags.push('lp_locked');
  }

  score = clamp(score, 0, 10);

  return { score, level: levelFor(score), flags };
}
