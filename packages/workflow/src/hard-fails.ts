/**
 * Hard-fail checks.
 *
 * Spec 16.1 lists conditions that must block promotion regardless of how good
 * the headline numbers look. The build prompt states one explicitly: "Do not
 * permit PAPER_APPROVED when required verification evidence is missing or
 * parity is FAIL." ADR 0002 adds that engine evidence alone is never
 * sufficient for approval.
 *
 * These are deterministic application code, not prompts. CLAUDE.md 3.7: a
 * model recommendation is evidence, not authority.
 */
import type { EvidenceKind } from './transitions.js';

export type ParityVerdict = 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT_DATA';
export type BacktestSource = 'tradingview_csv' | 'mcp_engine' | 'local_runner';

export interface PromotionFacts {
  readonly parityVerdict: ParityVerdict | null;
  /** Every source that produced evidence for this version. */
  readonly evidenceSources: readonly BacktestSource[];
  readonly closedTradeCount: number;
  readonly maxDrawdownPct: number;
  /** True when any backtest attached to this version failed or errored. */
  readonly hasUnresolvedFailedRun: boolean;
  readonly presentEvidence: readonly EvidenceKind[];
}

export interface HardFail {
  readonly code: string;
  readonly detail: string;
}

/** Spec 25 policy default: warn below 100 closed trades. */
export const MINIMUM_TRADE_COUNT = 100;

/**
 * Returns every hard failure, not just the first. A reviewer needs the whole
 * picture, and spec 18.3 requires the decision dialog to show all hard
 * failures rather than stopping at one.
 */
export function checkPromotionHardFails(facts: PromotionFacts): readonly HardFail[] {
  const failures: HardFail[] = [];

  if (facts.parityVerdict === null) {
    failures.push({
      code: 'parity_missing',
      detail: 'No parity report exists for this version.',
    });
  } else if (facts.parityVerdict === 'FAIL') {
    failures.push({
      code: 'parity_failed',
      detail: 'Parity comparison failed; local and TradingView results diverge.',
    });
  } else if (facts.parityVerdict === 'INSUFFICIENT_DATA') {
    failures.push({
      code: 'parity_insufficient',
      detail: 'Parity could not be evaluated from the evidence supplied.',
    });
  }

  // ADR 0002: the MCP engine is the scale path, TradingView the acceptance
  // environment. Engine-only evidence cannot promote.
  if (!facts.evidenceSources.includes('tradingview_csv')) {
    failures.push({
      code: 'no_tradingview_evidence',
      detail:
        'Promotion requires a TradingView-sourced run. Engine evidence alone is not acceptance evidence (ADR 0002).',
    });
  }

  if (facts.hasUnresolvedFailedRun) {
    failures.push({
      code: 'unresolved_failed_run',
      detail: 'A failed backtest run is attached to this version and has not been resolved.',
    });
  }

  if (facts.closedTradeCount < MINIMUM_TRADE_COUNT) {
    failures.push({
      code: 'insufficient_trades',
      detail: `Closed trade count ${facts.closedTradeCount} is below the minimum of ${MINIMUM_TRADE_COUNT}.`,
    });
  }

  if (!Number.isFinite(facts.maxDrawdownPct)) {
    // CLAUDE.md 14 forbids silently dropping NaN. An unknown drawdown is a
    // failure, never a pass.
    failures.push({
      code: 'drawdown_unknown',
      detail: 'Maximum drawdown is not a finite number; evidence is incomplete.',
    });
  }

  return failures;
}
