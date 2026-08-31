/**
 * Walk-forward segment planning.
 *
 * Spec 12.2 defines the segment models and 12.3 the embargo and warm-up rules.
 * This module is pure: it turns a date range into a plan and does nothing
 * else, so every rule below is testable without a network or a credit.
 *
 * The embargo is the part people skip and the part that matters. Without a gap
 * between the in-sample window and the out-of-sample window, a trade opened
 * near the end of training can close inside the test period, and information
 * leaks across the boundary. Spec 12.3 requires the gap; this refuses to build
 * a plan without one.
 */

export type SegmentModel = 'rolling_walk_forward' | 'anchored_walk_forward' | 'fixed_split';

export interface WalkForwardConfig {
  readonly from: string;
  readonly to: string;
  readonly model: SegmentModel;
  /** Length of each training window, in days. */
  readonly inSampleDays: number;
  /** Length of each test window, in days. */
  readonly outOfSampleDays: number;
  /** Gap between training and test, in days. Must be greater than zero. */
  readonly embargoDays: number;
  /** Bars of indicator warm-up excluded from evaluation (spec 12.3). */
  readonly warmupDays?: number;
}

export interface SegmentWindow {
  readonly index: number;
  readonly scope: 'IN_SAMPLE' | 'OUT_OF_SAMPLE';
  readonly from: string;
  readonly to: string;
  /** Groups the in-sample and out-of-sample halves of one fold. */
  readonly foldId: number;
}

export interface WalkForwardPlan {
  readonly model: SegmentModel;
  readonly windows: readonly SegmentWindow[];
  readonly foldCount: number;
  /** One backtest per window. This is the credit cost of executing the plan. */
  readonly runCount: number;
  readonly warnings: readonly string[];
}

export class SegmentPlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SegmentPlanError';
    this.code = code;
  }
}

const DAY_MS = 86_400_000;

function parseDay(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SegmentPlanError('invalid_date', `${label} is not a parseable date: ${value}`);
  }
  return parsed;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Builds the fold plan.
 *
 * Rolling advances both ends of the training window; anchored keeps the start
 * fixed and only extends the end, which is the right model when the strategy
 * is expected to benefit from more history rather than recent history.
 */
export function planWalkForward(config: WalkForwardConfig): WalkForwardPlan {
  const start = parseDay(config.from, 'from');
  const end = parseDay(config.to, 'to');
  const warnings: string[] = [];

  if (end <= start) {
    throw new SegmentPlanError('empty_range', 'The end date must be after the start date.');
  }
  if (config.inSampleDays <= 0 || config.outOfSampleDays <= 0) {
    throw new SegmentPlanError('invalid_window', 'Window lengths must be greater than zero.');
  }
  // Spec 12.3. A zero embargo lets a position opened in training close during
  // the test window, which leaks the outcome across the boundary.
  if (config.embargoDays <= 0) {
    throw new SegmentPlanError(
      'missing_embargo',
      'An embargo of at least one day is required between in-sample and out-of-sample windows (spec 12.3).',
    );
  }

  const warmup = config.warmupDays ?? 0;
  const inSample = config.inSampleDays * DAY_MS;
  const embargo = config.embargoDays * DAY_MS;
  const outOfSample = config.outOfSampleDays * DAY_MS;
  const foldSpan = inSample + embargo + outOfSample;

  if (config.model === 'fixed_split') {
    if (start + foldSpan > end) {
      throw new SegmentPlanError('range_too_short', 'The range is shorter than a single fold.');
    }
    const isFrom = start + warmup * DAY_MS;
    const isTo = start + inSample;
    const oosFrom = isTo + embargo;
    return {
      model: config.model,
      foldCount: 1,
      runCount: 2,
      windows: [
        { index: 0, foldId: 0, scope: 'IN_SAMPLE', from: iso(isFrom), to: iso(isTo) },
        { index: 1, foldId: 0, scope: 'OUT_OF_SAMPLE', from: iso(oosFrom), to: iso(end) },
      ],
      warnings,
    };
  }

  const windows: SegmentWindow[] = [];
  let foldId = 0;
  let cursor = start;

  while (cursor + foldSpan <= end) {
    const isStart = config.model === 'anchored_walk_forward' ? start : cursor;
    const isFrom = isStart + (foldId === 0 ? warmup * DAY_MS : 0);
    const isTo = cursor + inSample;
    const oosFrom = isTo + embargo;
    const oosTo = oosFrom + outOfSample;

    windows.push(
      { index: windows.length, foldId, scope: 'IN_SAMPLE', from: iso(isFrom), to: iso(isTo) },
      { index: windows.length + 1, foldId, scope: 'OUT_OF_SAMPLE', from: iso(oosFrom), to: iso(oosTo) },
    );

    // Folds advance by the test window, so every day of history is tested
    // out-of-sample exactly once.
    cursor += outOfSample;
    foldId += 1;
  }

  if (windows.length === 0) {
    throw new SegmentPlanError(
      'range_too_short',
      `The range spans ${Math.round((end - start) / DAY_MS)} days but a fold needs ${Math.round(foldSpan / DAY_MS)}.`,
    );
  }

  if (foldId < 3) {
    // Not fatal, but three folds is the fewest from which degradation can be
    // told from noise, so the caller should know before trusting the result.
    warnings.push(
      `Only ${foldId} fold(s) fit in this range. Fewer than three makes out-of-sample degradation hard to distinguish from chance.`,
    );
  }

  return { model: config.model, windows, foldCount: foldId, runCount: windows.length, warnings };
}
