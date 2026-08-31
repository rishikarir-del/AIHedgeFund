/**
 * Walk-forward execution as a persisted job.
 *
 * Each fold window becomes a `backtest_runs` row with its own trades, equity,
 * metric snapshot and parity report, scoped IN_SAMPLE or OUT_OF_SAMPLE. That
 * is what turns a sweep from a number on a terminal into evidence attached to
 * an immutable strategy version.
 *
 * Section 3.2 applies here as everywhere: this writes evidence and emits an
 * event. It does not move the version's lifecycle state. Whether nine folds
 * justify promotion is the workflow engine's decision, made through the API.
 *
 * The budget check lives in @arf/backtest-sdk and runs before the first
 * request, so an over-budget sweep costs nothing rather than stopping halfway.
 */
import { eq } from 'drizzle-orm';
import {
  ObjectStore,
  backtestRuns,
  outboxEvents,
  pineRevisions,
  strategyVersions,
  trades,
  type Database,
} from '@arf/db';
import {
  McpBacktestRunner,
  planWalkForward,
  runWalkForward,
  type SegmentModel,
} from '@arf/backtest-sdk';
import { hashPineSource } from '@arf/pine';
import { computeEvidence } from './compute-evidence.js';

export interface WalkForwardPayload {
  readonly strategyVersionId: string;
  readonly organisationId: string;
  /** Object-store key of the stored Pine revision. The source is fetched, not sent: a queue payload is effectively a log, and shipping the script through it would bloat every job record. */
  readonly artefactKey: string;
  readonly sourceHash: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly from: string;
  readonly to: string;
  readonly initialCapital: string;
  readonly model: SegmentModel;
  readonly inSampleDays: number;
  readonly outOfSampleDays: number;
  readonly embargoDays: number;
  readonly maxRuns: number;
}

export interface WalkForwardJobResult {
  readonly runIds: readonly string[];
  readonly foldsCompleted: number;
  readonly foldsOutOfSampleProfitable: number;
  readonly runsSpent: number;
  readonly warnings: readonly string[];
}

export async function executeWalkForward(
  db: Database,
  store: ObjectStore,
  endpoint: string,
  payload: WalkForwardPayload,
): Promise<WalkForwardJobResult> {
  const [version] = await db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.id, payload.strategyVersionId))
    .limit(1);
  if (!version) {
    throw new Error(`Strategy version ${payload.strategyVersionId} not found`);
  }

  const [revision] = await db
    .select()
    .from(pineRevisions)
    .where(eq(pineRevisions.strategyVersionId, payload.strategyVersionId))
    .limit(1);
  if (!revision) {
    throw new Error(`Version ${payload.strategyVersionId} has no stored Pine revision`);
  }

  const pineSource = (await store.getObject(payload.artefactKey)).toString('utf8');

  // The stored source must still hash to what the revision recorded.
  // Otherwise the evidence would attach to a version it was not produced
  // from, which is the lineage section 3.1 exists to guarantee.
  const actualHash = hashPineSource(pineSource);
  if (actualHash !== payload.sourceHash) {
    throw new Error(
      `Stored Pine does not match the revision hash. Expected ${payload.sourceHash}, got ${actualHash}. ` +
        'Refusing to attach evidence to a version the source did not produce.',
    );
  }

  const plan = planWalkForward({
    from: payload.from,
    to: payload.to,
    model: payload.model,
    inSampleDays: payload.inSampleDays,
    outOfSampleDays: payload.outOfSampleDays,
    embargoDays: payload.embargoDays,
  });

  const runner = new McpBacktestRunner({ endpoint });
  const report = await runWalkForward(runner, plan, {
    pineSource,
    symbol: payload.symbol,
    timeframe: payload.timeframe,
    initialCapital: payload.initialCapital,
    maxRuns: payload.maxRuns,
  });

  const runIds: string[] = [];

  for (const outcome of report.outcomes) {
    // A fold that failed produced no result. It is already recorded as a
    // warning on the report; inventing a row for it would fabricate evidence.
    if (!outcome.result) continue;

    const result = outcome.result;
    const window = outcome.window;

    const runId = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(backtestRuns)
        .values({
          organisationId: payload.organisationId,
          strategyVersionId: payload.strategyVersionId,
          source: 'mcp_engine',
          sourceIdentity: {
            engine: result.runnerName,
            engineVersion: result.runnerVersion,
            externalResultId: result.externalResultId,
          },
          symbol: payload.symbol,
          timeframe: payload.timeframe,
          initialCapital: payload.initialCapital,
          // The window is part of the plan, so a reader can tell which slice
          // of history this run covers without consulting the sweep.
          plan: {
            walkForward: {
              model: plan.model,
              foldId: window.foldId,
              scope: window.scope,
              from: window.from,
              to: window.to,
              embargoDays: payload.embargoDays,
            },
          },
          codeHash: result.codeHash,
          manifestHash: result.manifestHash,
          datasetHash: result.datasetHash,
          reportedMetrics: { ...result.reportedMetrics, warnings: result.warnings },
        })
        .returning();
      if (!run) throw new Error('Backtest run insert returned no row');

      if (result.trades.length > 0) {
        await tx
          .insert(trades)
          .values(
            result.trades.map((trade) => ({
              runId: run.id,
              sequence: trade.sequence,
              direction: trade.direction,
              entryTime: new Date(trade.entryTime),
              exitTime: trade.exitTime ? new Date(trade.exitTime) : null,
              entryPrice: trade.entryPrice,
              exitPrice: trade.exitPrice,
              quantity: trade.quantity,
              profit: trade.profit,
            })),
          )
          .onConflictDoNothing();
      }

      return run.id;
    });

    // Equity, metrics and parity are computed from the stored ledger rather
    // than from the engine's reply, which is what makes them independent.
    await computeEvidence(db, { runId, scope: window.scope });
    runIds.push(runId);
  }

  await db.insert(outboxEvents).values({
    eventType: 'walk_forward.completed',
    payload: {
      strategyVersionId: payload.strategyVersionId,
      foldsCompleted: report.foldsCompleted,
      foldsOutOfSampleProfitable: report.foldsOutOfSampleProfitable,
      runsSpent: report.runsSpent,
      runIds,
    },
  });

  return {
    runIds,
    foldsCompleted: report.foldsCompleted,
    foldsOutOfSampleProfitable: report.foldsOutOfSampleProfitable,
    runsSpent: report.runsSpent,
    // Duplicate warnings across folds are collapsed: eighteen identical
    // messages bury the one that differs.
    warnings: [...new Set(report.warnings)],
  };
}
