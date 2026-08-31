/**
 * Walk-forward execution.
 *
 * Runs a plan through a `BacktestRunner` and reports how far performance falls
 * from in-sample to out-of-sample. That gap is the finding: a strategy that
 * looks good in training and collapses in test is overfitted, and spec 24
 * names overfitting by scale as a principal risk.
 *
 * Two rules are enforced here rather than left to the caller.
 *
 * A budget is mandatory. Every window is a backtest and every backtest costs a
 * credit, so the plan is priced before anything runs and refused outright if
 * it exceeds the ceiling. A partial sweep that stops halfway through having
 * spent the budget is worse than one that never started.
 *
 * Nothing is aggregated across scopes. Spec 14 forbids comparing metrics
 * across incompatible scopes without a clearly named aggregation, so
 * in-sample and out-of-sample figures stay separate and the comparison
 * between them is the named thing.
 */
import type { BacktestResult, BacktestRunner } from './types.js';
import type { SegmentWindow, WalkForwardPlan } from './segments.js';

export interface SegmentRunConfig {
  readonly pineSource: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly initialCapital: string;
  /** Hard ceiling on backtests. The plan is refused if it needs more. */
  readonly maxRuns: number;
  /** Called before each run, so a caller can log or abort. */
  readonly onProgress?: (window: SegmentWindow, completed: number, total: number) => void;
}

export interface SegmentOutcome {
  readonly window: SegmentWindow;
  readonly result: BacktestResult | null;
  readonly error: string | null;
}

export interface FoldComparison {
  readonly foldId: number;
  readonly inSampleNetProfit: number | null;
  readonly outOfSampleNetProfit: number | null;
  /**
   * Out-of-sample net profit as a fraction of in-sample. Null when either side
   * is unknown or in-sample made nothing, because a ratio against zero is not
   * a degradation measurement.
   */
  readonly retention: number | null;
  readonly outOfSampleProfitable: boolean | null;
}

export interface WalkForwardReport {
  readonly plan: WalkForwardPlan;
  readonly outcomes: readonly SegmentOutcome[];
  readonly folds: readonly FoldComparison[];
  readonly foldsCompleted: number;
  readonly foldsOutOfSampleProfitable: number;
  readonly runsSpent: number;
  readonly warnings: readonly string[];
}

export class BudgetExceededError extends Error {
  constructor(required: number, allowed: number) {
    super(
      `This plan needs ${required} backtests but the budget allows ${allowed}. ` +
        'Widen the budget or shorten the plan; a sweep that stops halfway has spent the credits for nothing.',
    );
    this.name = 'BudgetExceededError';
  }
}

function netProfitOf(result: BacktestResult | null): number | null {
  if (!result) return null;
  const raw = result.reportedMetrics['netProfit'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function runWalkForward(
  runner: BacktestRunner,
  plan: WalkForwardPlan,
  config: SegmentRunConfig,
): Promise<WalkForwardReport> {
  // Priced before anything runs.
  if (plan.runCount > config.maxRuns) {
    throw new BudgetExceededError(plan.runCount, config.maxRuns);
  }

  const outcomes: SegmentOutcome[] = [];
  const warnings: string[] = [...plan.warnings];
  let runsSpent = 0;

  for (const window of plan.windows) {
    config.onProgress?.(window, runsSpent, plan.runCount);

    try {
      const result = await runner.run({
        pineSource: config.pineSource,
        symbol: config.symbol,
        timeframe: config.timeframe,
        from: window.from,
        to: window.to,
        initialCapital: config.initialCapital,
        notes: `walk-forward fold ${window.foldId} ${window.scope.toLowerCase()}`,
      });
      runsSpent += 1;
      outcomes.push({ window, result, error: null });

      // Runner warnings are per-window and must not be flattened away: a
      // clamped date range on one fold changes what that fold means.
      for (const warning of result.warnings) {
        warnings.push(`fold ${window.foldId} ${window.scope}: ${warning}`);
      }
    } catch (error) {
      // A credit may still have been spent, so count it. Continuing lets the
      // remaining folds produce a partial but honest picture.
      runsSpent += 1;
      const detail = error instanceof Error ? error.message : 'unknown error';
      outcomes.push({ window, result: null, error: detail });
      warnings.push(`fold ${window.foldId} ${window.scope} failed: ${detail}`);
    }
  }

  const folds: FoldComparison[] = [];
  for (let foldId = 0; foldId < plan.foldCount; foldId += 1) {
    const inSample = outcomes.find((o) => o.window.foldId === foldId && o.window.scope === 'IN_SAMPLE');
    const outOfSample = outcomes.find(
      (o) => o.window.foldId === foldId && o.window.scope === 'OUT_OF_SAMPLE',
    );

    const isProfit = netProfitOf(inSample?.result ?? null);
    const oosProfit = netProfitOf(outOfSample?.result ?? null);

    folds.push({
      foldId,
      inSampleNetProfit: isProfit,
      outOfSampleNetProfit: oosProfit,
      // Undefined against a zero or negative in-sample result: "kept 50% of
      // nothing" is not a meaningful statement about degradation.
      retention: isProfit !== null && oosProfit !== null && isProfit > 0 ? oosProfit / isProfit : null,
      outOfSampleProfitable: oosProfit === null ? null : oosProfit > 0,
    });
  }

  const completed = folds.filter((f) => f.outOfSampleNetProfit !== null).length;
  const profitable = folds.filter((f) => f.outOfSampleProfitable === true).length;

  if (completed > 0 && profitable === 0) {
    warnings.push(
      'No fold was profitable out of sample. This is the expected signature of an overfitted strategy.',
    );
  }

  return {
    plan,
    outcomes,
    folds,
    foldsCompleted: completed,
    foldsOutOfSampleProfitable: profitable,
    runsSpent,
    warnings,
  };
}
