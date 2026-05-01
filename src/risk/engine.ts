import { z } from 'zod';

export const RiskLevelSchema = z.enum(['clean', 'caution', 'risky', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type RiskConfidence = z.infer<typeof RiskConfidenceSchema>;

export interface RiskInput {
  // Blockscout forensics
  top10ConcentrationPct: number | null;
  deployerHoldingsPct: number | null;
  verified: boolean | null;
  lpLocked: boolean | null;

  // Populated only when their upstream MCPs are wired in (DexScreener / Honeypot).
  isHoneypot?: boolean | null;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  liquidityUsd?: number | null;
  pairAgeHours?: number | null;
}

export interface RiskComponent {
  /** Stable rule id (matches `flag` for risk rules; mitigants share the rule id). */
  id: string;
  /** Points contributed (negative for mitigants). Half-points may appear before final rounding. */
  points: number;
  /** Human-readable flag string emitted into `flags`. */
  flag: string;
  /** Human-readable detail of the matched tier (e.g., "top-10 hold 82.4%"). */
  detail: string;
  /** True for risk-reducing contributions like `lp_locked`. */
  isMitigant?: boolean;
}

export interface RiskCoverage {
  /** Number of rules whose inputs were available. */
  evaluated: number;
  /** Total number of rules in the registry. */
  total: number;
  /** Rule ids whose required inputs were missing. */
  missing: string[];
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  flags: string[];
  /** Itemized contributions (risks and mitigants) in deterministic registry order. */
  components: RiskComponent[];
  /** Subset of `flags` that reduced risk (e.g., `lp_locked`). Duplicated for compatibility. */
  mitigants: string[];
  coverage: RiskCoverage;
  confidence: RiskConfidence;
}

export const RISK_THRESHOLDS = {
  CLEAN: 2,
  CAUTION: 5,
  RISKY: 8,
};

const CONFIDENCE_HIGH_RATIO = 0.75;
const CONFIDENCE_MEDIUM_RATIO = 0.5;

type RuleEval =
  | { status: 'missing' }
  | { status: 'clean' }
  | {
      status: 'flagged';
      points: number;
      flag: string;
      detail: string;
      isMitigant?: boolean;
    };

interface Rule {
  id: string;
  evaluate(input: RiskInput): RuleEval;
}

function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

/**
 * Rules are evaluated in the order they appear here; this also dictates the
 * order of `components` and `flags` in the result. Each rule uses a single
 * threshold; the registry structure exists to support per-rule isolation,
 * coverage tracking, and itemized `components` output.
 */
const RULES: Rule[] = [
  {
    id: 'honeypot_detected',
    evaluate(input) {
      if (input.isHoneypot === undefined || input.isHoneypot === null) return { status: 'missing' };
      if (input.isHoneypot === true) {
        return {
          status: 'flagged',
          points: 4,
          flag: 'honeypot_detected',
          detail: 'honeypot simulation failed',
        };
      }
      return { status: 'clean' };
    },
  },
  {
    id: 'high_tax',
    evaluate(input) {
      const buy = input.buyTaxPct;
      const sell = input.sellTaxPct;
      if ((buy === undefined || buy === null) && (sell === undefined || sell === null)) {
        return { status: 'missing' };
      }
      const max = Math.max(
        typeof buy === 'number' ? buy : -Infinity,
        typeof sell === 'number' ? sell : -Infinity,
      );
      if (max > 10) {
        return {
          status: 'flagged',
          points: 2,
          flag: 'high_tax',
          detail: `max tax ${pct(max)}`,
        };
      }
      return { status: 'clean' };
    },
  },
  {
    id: 'high_concentration',
    evaluate(input) {
      const v = input.top10ConcentrationPct;
      if (v === null || v === undefined) return { status: 'missing' };
      if (v > 70) {
        return {
          status: 'flagged',
          points: 2,
          flag: 'high_concentration',
          detail: `top-10 hold ${pct(v)}`,
        };
      }
      return { status: 'clean' };
    },
  },
  {
    id: 'deployer_holds_large',
    evaluate(input) {
      const v = input.deployerHoldingsPct;
      if (v === null || v === undefined) return { status: 'missing' };
      if (v > 20) {
        return {
          status: 'flagged',
          points: 1,
          flag: 'deployer_holds_large',
          detail: `deployer holds ${pct(v)}`,
        };
      }
      return { status: 'clean' };
    },
  },
  {
    id: 'unverified_contract',
    evaluate(input) {
      if (input.verified === null || input.verified === undefined) return { status: 'missing' };
      if (input.verified === false) {
        return {
          status: 'flagged',
          points: 1,
          flag: 'unverified_contract',
          detail: 'contract source not verified',
        };
      }
      return { status: 'clean' };
    },
  },
  {
    id: 'low_liquidity',
    evaluate(input) {
      const v = input.liquidityUsd;
      if (v === undefined || v === null) return { status: 'missing' };
      if (v < 10_000) {
        return {
          status: 'flagged',
          points: 1,
          flag: 'low_liquidity',
          detail: `liquidity $${Math.round(v).toLocaleString('en-US')}`,
        };
      }
      return { status: 'clean' };
    },
  },
  {
    id: 'new_pair',
    evaluate(input) {
      const v = input.pairAgeHours;
      if (v === undefined || v === null) return { status: 'missing' };
      if (v < 24) {
        return {
          status: 'flagged',
          points: 1,
          flag: 'new_pair',
          detail: `pair age ${Math.max(0, Math.round(v * 10) / 10)}h`,
        };
      }
      return { status: 'clean' };
    },
  },
  {
    id: 'lp_locked',
    evaluate(input) {
      if (input.lpLocked === null || input.lpLocked === undefined) return { status: 'missing' };
      if (input.lpLocked === true) {
        return {
          status: 'flagged',
          points: -1,
          flag: 'lp_locked',
          detail: 'LP held by burn/dead address',
          isMitigant: true,
        };
      }
      return { status: 'clean' };
    },
  },
];

/**
 * Deterministic risk scoring engine.
 *
 * Rules (single threshold per rule, identical to prior versions of this engine):
 * - honeypot:      true → +4
 * - taxes:         max(buy,sell) > 10  → +2
 * - concentration: top10 > 70          → +2
 * - deployer:      pct  > 20           → +1
 * - verified:      false               → +1
 * - liquidity:     < $10k              → +1
 * - pair age:      < 24h               → +1
 * - lp locked:     true                → -1 (mitigant)
 *
 * Final score is clamped to 0..10. Level mapping:
 * 0–2 = clean, 3–5 = caution, 6–8 = risky, 9–10 = critical.
 *
 * Inputs may be `null`/`undefined` when upstream data is unavailable. Such
 * rules contribute 0 and are reported in `coverage.missing`; `confidence`
 * reflects how many rules were evaluated.
 */
export function computeRisk(input: RiskInput): RiskResult {
  const components: RiskComponent[] = [];
  const flags: string[] = [];
  const mitigants: string[] = [];
  const missing: string[] = [];
  let raw = 0;
  let evaluated = 0;

  for (const rule of RULES) {
    const r = rule.evaluate(input);
    if (r.status === 'missing') {
      missing.push(rule.id);
      continue;
    }
    evaluated += 1;
    if (r.status === 'clean') continue;
    raw += r.points;
    flags.push(r.flag);
    components.push({
      id: rule.id,
      points: r.points,
      flag: r.flag,
      detail: r.detail,
      ...(r.isMitigant ? { isMitigant: true } : {}),
    });
    if (r.isMitigant) mitigants.push(r.flag);
  }

  const finalScore = Math.max(0, Math.min(10, Math.round(raw)));

  const coverage: RiskCoverage = {
    evaluated,
    total: RULES.length,
    missing,
  };
  const ratio = RULES.length === 0 ? 0 : evaluated / RULES.length;
  const confidence: RiskConfidence =
    ratio >= CONFIDENCE_HIGH_RATIO ? 'high' : ratio >= CONFIDENCE_MEDIUM_RATIO ? 'medium' : 'low';

  return {
    score: finalScore,
    level: mapScoreToLevel(finalScore),
    flags,
    components,
    mitigants,
    coverage,
    confidence,
  };
}

function mapScoreToLevel(score: number): RiskLevel {
  if (score <= RISK_THRESHOLDS.CLEAN) return 'clean';
  if (score <= RISK_THRESHOLDS.CAUTION) return 'caution';
  if (score <= RISK_THRESHOLDS.RISKY) return 'risky';
  return 'critical';
}
