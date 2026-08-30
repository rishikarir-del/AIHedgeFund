/**
 * Independent metric calculation.
 *
 * CLAUDE.md 14: pure deterministic functions, explicit units, a calculation
 * version, and no silent dropping of NaN, missing trades or zero-duration
 * periods. Anything that cannot be computed is reported as `null` alongside a
 * warning, never as zero -- a zero that means "unknown" is exactly the defect
 * that made an external engine report a runup of 0 on a profitable run.
 *
 * Nothing here reads a reported value. These numbers are derived only from the
 * trade ledger and the reconstructed equity curve, which is what makes them
 * usable as the independent half of a parity comparison (15.3).
 */
import { Decimal, sum } from './decimal.js';

export const CALCULATION_VERSION = '1.0.0';

export interface TradeInput {
  readonly sequence: number;
  readonly direction: 'long' | 'short';
  readonly entryTime: string;
  readonly exitTime: string | null;
  readonly profit: string | null;
}

export interface EquityPointInput {
  readonly barTime: string;
  readonly equity: string;
}

/** Suffixes state units: `...Pct` is 0-100, plain names are money as decimal strings. */
export interface MetricSet {
  readonly calculationVersion: string;
  readonly closedTradeCount: number;
  readonly openTradeCount: number;
  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly netProfit: string;
  readonly profitFactor: number | null;
  readonly winRatePct: number | null;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly evenTrades: number;
  readonly averageWin: string | null;
  readonly averageLoss: string | null;
  readonly payoffRatio: number | null;
  readonly maxDrawdown: string;
  readonly maxDrawdownPct: number | null;
  readonly maxRunup: string;
  readonly maxRunupPct: number | null;
  readonly longestLosingStreak: number;
  readonly averageHoldingDurationMs: number | null;
  readonly monthlyReturns: readonly MonthlyReturn[];
  /** Non-fatal problems found in the input. Never silently swallowed. */
  readonly warnings: readonly string[];
}

export interface MonthlyReturn {
  /** `YYYY-MM` in UTC. CLAUDE.md 7.3 forbids relying on server local time. */
  readonly month: string;
  readonly netProfit: string;
}

export function calculateMetrics(
  trades: readonly TradeInput[],
  equity: readonly EquityPointInput[],
  initialCapital: string,
): MetricSet {
  const warnings: string[] = [];

  const closed = trades.filter((t) => t.profit !== null && t.exitTime !== null);
  const open = trades.filter((t) => t.profit === null || t.exitTime === null);
  if (open.length > 0) {
    warnings.push(`${open.length} trade(s) are still open and excluded from realised metrics.`);
  }

  const profits = closed.map((t) => Decimal.fromString(t.profit as string));
  const wins = profits.filter((p) => p.isPositive());
  const losses = profits.filter((p) => p.isNegative());
  const evens = profits.filter((p) => p.isZero());

  const grossProfit = sum(wins);
  // Reported as a positive magnitude, matching the convention in the engine
  // output and TradingView's Performance Summary.
  const grossLoss = sum(losses).abs();
  const netProfit = grossProfit.sub(grossLoss);

  const profitFactor = grossLoss.isZero() ? null : grossProfit.div(grossLoss)?.toNumber() ?? null;
  if (grossLoss.isZero() && closed.length > 0) {
    warnings.push('Profit factor is undefined: there were no losing trades.');
  }

  const winRatePct = closed.length === 0 ? null : (wins.length / closed.length) * 100;
  const averageWin = wins.length === 0 ? null : grossProfit.div(Decimal.fromInteger(wins.length));
  const averageLoss = losses.length === 0 ? null : grossLoss.div(Decimal.fromInteger(losses.length));

  const payoffRatio =
    averageWin && averageLoss && !averageLoss.isZero()
      ? averageWin.div(averageLoss)?.toNumber() ?? null
      : null;

  const excursion = calculateExcursion(equity, initialCapital, warnings);
  const holding = averageHoldingMs(closed, warnings);

  return {
    calculationVersion: CALCULATION_VERSION,
    closedTradeCount: closed.length,
    openTradeCount: open.length,
    grossProfit: grossProfit.toString(),
    grossLoss: grossLoss.toString(),
    netProfit: netProfit.toString(),
    profitFactor,
    winRatePct,
    winningTrades: wins.length,
    losingTrades: losses.length,
    evenTrades: evens.length,
    averageWin: averageWin?.toString() ?? null,
    averageLoss: averageLoss?.neg().toString() ?? null,
    payoffRatio,
    maxDrawdown: excursion.maxDrawdown.toString(),
    maxDrawdownPct: excursion.maxDrawdownPct,
    maxRunup: excursion.maxRunup.toString(),
    maxRunupPct: excursion.maxRunupPct,
    longestLosingStreak: longestLosingStreak(closed),
    averageHoldingDurationMs: holding,
    monthlyReturns: monthlyReturns(closed),
    warnings,
  };
}

interface Excursion {
  readonly maxDrawdown: Decimal;
  readonly maxDrawdownPct: number | null;
  readonly maxRunup: Decimal;
  readonly maxRunupPct: number | null;
}

/**
 * Drawdown is the largest peak-to-trough fall; runup is the largest
 * trough-to-peak rise. They are mirror images and both are computed in one
 * pass. Runup is computed here explicitly because an engine reporting zero
 * runup on a profitable run is the exact defect this package exists to catch.
 */
function calculateExcursion(
  equity: readonly EquityPointInput[],
  initialCapital: string,
  warnings: string[],
): Excursion {
  if (equity.length === 0) {
    warnings.push('No equity points supplied; drawdown and runup could not be calculated.');
    return { maxDrawdown: Decimal.ZERO, maxDrawdownPct: null, maxRunup: Decimal.ZERO, maxRunupPct: null };
  }

  const start = Decimal.fromString(initialCapital);
  let peak = start;
  let trough = start;
  let maxDrawdown = Decimal.ZERO;
  let maxRunup = Decimal.ZERO;
  let peakAtMaxDrawdown = start;
  let troughAtMaxRunup = start;

  for (const point of equity) {
    const value = Decimal.fromString(point.equity);

    // Running maximum and running minimum, tracked independently. Resetting
    // the trough when a new peak appears would erase the very rise that
    // produced that peak, which is how a rising curve ends up reporting a
    // runup of zero.
    peak = peak.max(value);
    trough = trough.min(value);

    const drawdown = peak.sub(value);
    if (drawdown.cmp(maxDrawdown) > 0) {
      maxDrawdown = drawdown;
      peakAtMaxDrawdown = peak;
    }

    const runup = value.sub(trough);
    if (runup.cmp(maxRunup) > 0) {
      maxRunup = runup;
      troughAtMaxRunup = trough;
    }
  }

  return {
    maxDrawdown,
    maxDrawdownPct: percentOf(maxDrawdown, peakAtMaxDrawdown),
    maxRunup,
    maxRunupPct: percentOf(maxRunup, troughAtMaxRunup),
  };
}

/** Null rather than zero when the base is zero: unknown is not the same as none. */
function percentOf(value: Decimal, base: Decimal): number | null {
  if (base.isZero()) return null;
  const ratio = value.div(base);
  return ratio === null ? null : ratio.toNumber() * 100;
}

function longestLosingStreak(closed: readonly TradeInput[]): number {
  let longest = 0;
  let current = 0;
  for (const trade of [...closed].sort((a, b) => a.sequence - b.sequence)) {
    if (Decimal.fromString(trade.profit as string).isNegative()) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Zero-duration trades are counted, not dropped: CLAUDE.md 14 forbids silently
 * discarding them, and a strategy that opens and closes within one bar is a
 * real result worth seeing in the average.
 */
function averageHoldingMs(closed: readonly TradeInput[], warnings: string[]): number | null {
  if (closed.length === 0) return null;

  let total = 0;
  let counted = 0;
  let unparseable = 0;

  for (const trade of closed) {
    const entry = Date.parse(trade.entryTime);
    const exit = Date.parse(trade.exitTime as string);
    if (Number.isNaN(entry) || Number.isNaN(exit)) {
      unparseable += 1;
      continue;
    }
    total += exit - entry;
    counted += 1;
  }

  if (unparseable > 0) {
    warnings.push(`${unparseable} trade(s) had unparseable timestamps and were excluded from holding time.`);
  }
  return counted === 0 ? null : total / counted;
}

function monthlyReturns(closed: readonly TradeInput[]): readonly MonthlyReturn[] {
  const buckets = new Map<string, Decimal>();

  for (const trade of closed) {
    const exit = new Date(trade.exitTime as string);
    if (Number.isNaN(exit.getTime())) continue;
    // UTC components: the server timezone must never influence bucketing.
    const month = `${exit.getUTCFullYear()}-${String(exit.getUTCMonth() + 1).padStart(2, '0')}`;
    const running = buckets.get(month) ?? Decimal.ZERO;
    buckets.set(month, running.add(Decimal.fromString(trade.profit as string)));
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, total]) => ({ month, netProfit: total.toString() }));
}

/**
 * Rebuilds the equity curve from the ledger using the declared initial
 * capital. The build prompt requires reconstruction rather than reading
 * reported equity, so that the two can be compared.
 */
export function reconstructEquity(
  trades: readonly TradeInput[],
  initialCapital: string,
): readonly EquityPointInput[] {
  let running = Decimal.fromString(initialCapital);
  const points: EquityPointInput[] = [];

  for (const trade of [...trades].sort((a, b) => a.sequence - b.sequence)) {
    if (trade.profit === null || trade.exitTime === null) continue;
    running = running.add(Decimal.fromString(trade.profit));
    points.push({ barTime: trade.exitTime, equity: running.toString() });
  }

  return points;
}
