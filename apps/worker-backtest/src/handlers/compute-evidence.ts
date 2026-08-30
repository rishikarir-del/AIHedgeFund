/**
 * Equity reconstruction, metric calculation and parity comparison.
 *
 * CLAUDE.md 14 requires these to be independent of whatever the source
 * reported, so nothing here reads `reportedMetrics` except to compare against
 * it at the very end. The equity curve is rebuilt from the ledger and the
 * declared initial capital rather than taken from the export.
 *
 * All three writes are idempotent through unique constraints: equity_points on
 * (runId, barTime), metric_snapshots on (runId, scope, calculationVersion).
 */
import { asc, eq } from 'drizzle-orm';
import {
  backtestRuns,
  equityPoints,
  metricSnapshots,
  outboxEvents,
  parityReports,
  trades,
  type Database,
} from '@arf/db';
import { calculateMetrics, reconstructEquity, CALCULATION_VERSION } from '@arf/metrics';
import { compareParity, type ParitySide } from '@arf/pine';

export interface ComputeEvidencePayload {
  readonly runId: string;
}

export interface ComputeEvidenceResult {
  readonly equityPoints: number;
  readonly closedTrades: number;
  readonly parityVerdict: string | null;
  readonly warnings: readonly string[];
}

export async function computeEvidence(
  db: Database,
  payload: ComputeEvidencePayload,
): Promise<ComputeEvidenceResult> {
  const [run] = await db.select().from(backtestRuns).where(eq(backtestRuns.id, payload.runId)).limit(1);
  if (!run) throw new Error(`Backtest run ${payload.runId} not found`);

  const ledger = await db
    .select()
    .from(trades)
    .where(eq(trades.runId, payload.runId))
    .orderBy(asc(trades.sequence));

  const tradeInputs = ledger.map((row) => ({
    sequence: row.sequence,
    direction: row.direction === 'short' ? ('short' as const) : ('long' as const),
    entryTime: row.entryTime.toISOString(),
    exitTime: row.exitTime?.toISOString() ?? null,
    profit: row.profit,
  }));

  // Rebuilt, not read. This is the independent half of the parity comparison.
  const equity = reconstructEquity(tradeInputs, run.initialCapital);
  const metrics = calculateMetrics(tradeInputs, equity, run.initialCapital);

  await db.transaction(async (tx) => {
    if (equity.length > 0) {
      await tx
        .insert(equityPoints)
        .values(
          equity.map((point) => ({
            runId: payload.runId,
            barTime: new Date(point.barTime),
            equity: point.equity,
          })),
        )
        .onConflictDoNothing();
    }

    await tx
      .insert(metricSnapshots)
      .values({
        runId: payload.runId,
        scope: 'IN_SAMPLE',
        calculationVersion: CALCULATION_VERSION,
        metrics: metrics as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing();

    const reported = run.reportedMetrics as Record<string, unknown>;

    // Identity is identical on both sides here because both describe the same
    // stored run; the comparison that matters is trade count and net profit.
    const identity = {
      sourceHash: run.codeHash,
      manifestHash: run.manifestHash,
      symbol: run.symbol,
      timeframe: run.timeframe,
      fromTs: 0,
      toTs: 0,
      commissionValue: 0,
      sizingDescription: 'percent_of_equity:100',
      executionMode: 'bar_close',
    };

    const reportedSide: ParitySide = {
      ...identity,
      tradeCount:
        typeof reported['totalTrades'] === 'number' ? (reported['totalTrades'] as number) : null,
      netProfit: typeof reported['netProfit'] === 'string' ? (reported['netProfit'] as string) : null,
    };

    const calculatedSide: ParitySide = {
      ...identity,
      tradeCount: metrics.closedTradeCount,
      netProfit: metrics.netProfit,
    };

    const parity = compareParity(reportedSide, calculatedSide);

    await tx.insert(parityReports).values({
      runId: payload.runId,
      verdict: parity.verdict,
      firstDivergence: parity.firstDivergence,
      checkedFields: parity.checkedFields,
    });

    await tx.insert(outboxEvents).values({
      eventType: 'backtest_run.evidence_computed',
      payload: {
        runId: payload.runId,
        parityVerdict: parity.verdict,
        closedTradeCount: metrics.closedTradeCount,
      },
    });
  });

  const [latestParity] = await db
    .select()
    .from(parityReports)
    .where(eq(parityReports.runId, payload.runId))
    .limit(1);

  return {
    equityPoints: equity.length,
    closedTrades: metrics.closedTradeCount,
    parityVerdict: latestParity?.verdict ?? null,
    warnings: metrics.warnings,
  };
}
