/**
 * Command Centre read model.
 *
 * The build prompt asks this screen for campaign counts, a strategy funnel,
 * pending TradingView verifications, jobs, recent decisions, and data/parse
 * failures. That is one coherent view, so it is one endpoint backed by a read
 * model (section 14.12) rather than six round trips from a server component.
 *
 * Every count is organisation-scoped (section 19). Nothing here is estimated
 * or projected: each figure is a count of stored rows, and where a figure
 * cannot be obtained it is null rather than zero.
 */
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { QueueInspector } from '@arf/event-bus';
import {
  backtestRuns,
  campaigns,
  committeeDecisions,
  metricSnapshots,
  outboxEvents,
  parityReports,
  strategies,
  strategyVersions,
  tradingviewVerifications,
  type Database,
} from '@arf/db';
import { guard } from '../lib/guards.js';
import { loadThresholds } from './mandate.js';

/** Every workflow state, so the funnel shows zeros rather than omitting them. */
const FUNNEL_ORDER = [
  'CAMPAIGN_BACKLOG',
  'IDEA_RESEARCH',
  'HYPOTHESIS_DRAFT',
  'PINE_DEVELOPMENT',
  'TRADINGVIEW_VERIFICATION',
  'PAPER_APPROVAL_REVIEW',
  'PAPER_APPROVED',
  'REJECTED',
  'BLOCKED',
] as const;

const AWAITING_VERIFICATION = ['REQUESTED', 'AWAITING_UPLOAD', 'PARSING'] as const;

export const DASHBOARD_QUEUES = ['report-parse', 'evidence-compute', 'domain-events'] as const;

export function registerDashboardRoutes(
  app: FastifyInstance,
  db: Database,
  inspector: QueueInspector | undefined,
): void {
  app.get('/v1/dashboard', async (request, reply) => {
    const actor = guard(request, 'campaign:read');
    const org = actor.organisationId;

    const [campaignRows, versionRows, pendingVerifications, recentDecisions, parseFailures] =
      await Promise.all([
        db.select({ total: count() }).from(campaigns).where(eq(campaigns.organisationId, org)),

        // Funnel counts come from versions, not strategies: a strategy has no
        // state of its own, and its versions can sit at different stages.
        db
          .select({ state: strategyVersions.state, total: count() })
          .from(strategyVersions)
          .where(eq(strategyVersions.organisationId, org))
          .groupBy(strategyVersions.state),

        db
          .select({ total: count() })
          .from(tradingviewVerifications)
          .where(
            and(
              eq(tradingviewVerifications.organisationId, org),
              inArray(tradingviewVerifications.status, [...AWAITING_VERIFICATION]),
            ),
          ),

        db
          .select({
            id: committeeDecisions.id,
            outcome: committeeDecisions.outcome,
            rationale: committeeDecisions.rationale,
            strategyVersionId: committeeDecisions.strategyVersionId,
            createdAt: committeeDecisions.createdAt,
          })
          .from(committeeDecisions)
          .where(eq(committeeDecisions.organisationId, org))
          .orderBy(desc(committeeDecisions.createdAt))
          .limit(10),

        // Parse failures are emitted by the ingestion worker as domain events.
        // They are surfaced here because a failed parse that nobody sees is
        // indistinguishable from an upload that never happened.
        db
          .select({
            id: outboxEvents.id,
            payload: outboxEvents.payload,
            createdAt: outboxEvents.createdAt,
          })
          .from(outboxEvents)
          .where(eq(outboxEvents.eventType, 'report.parse_failed'))
          .orderBy(desc(outboxEvents.createdAt))
          .limit(10),
      ]);

    const strategyTotal = await db
      .select({ total: count() })
      .from(strategies)
      .where(eq(strategies.organisationId, org));

    const byState = new Map(versionRows.map((row) => [row.state, row.total]));
    const funnel = FUNNEL_ORDER.map((state) => ({ state, count: byState.get(state) ?? 0 }));

    // Null rather than an empty array when there is no broker: "we cannot see
    // the queues" is a different claim from "the queues are empty".
    const queues = inspector ? await inspector.depths(DASHBOARD_QUEUES) : null;

    return reply.send({
      campaigns: { total: campaignRows[0]?.total ?? 0 },
      strategies: { total: strategyTotal[0]?.total ?? 0 },
      funnel,
      verifications: { pending: pendingVerifications[0]?.total ?? 0 },
      decisions: { recent: recentDecisions },
      parseFailures: { recent: parseFailures },
      queues,
      generatedAt: new Date().toISOString(),
    });
  });
}

export { sql };

/**
 * Markets tested, with the evidence each has accumulated.
 *
 * The starred column is NOT an investment recommendation, and cannot be. It
 * reports whether a market's evidence clears the mechanical gates the workflow
 * engine already enforces for promotion: out-of-sample results exist, parity is
 * not FAIL, and the closed-trade count meets the section 25 minimum.
 *
 * Section 1.3 places live approval outside this system entirely, so nothing
 * here may present itself as a reason to deploy capital.
 */
export function registerMarketRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/markets', async (request, reply) => {
    const actor = guard(request, 'strategy:read');
    const { thresholds, version: mandateVersion } = await loadThresholds(db, actor.organisationId);

    const rows = await db
      .select({
        symbol: backtestRuns.symbol,
        timeframe: backtestRuns.timeframe,
        runId: backtestRuns.id,
        source: backtestRuns.source,
        strategyVersionId: backtestRuns.strategyVersionId,
      })
      .from(backtestRuns)
      .where(eq(backtestRuns.organisationId, actor.organisationId));

    const snapshots = await db
      .select({
        runId: metricSnapshots.runId,
        scope: metricSnapshots.scope,
        metrics: metricSnapshots.metrics,
      })
      .from(metricSnapshots);

    const parities = await db
      .select({ runId: parityReports.runId, verdict: parityReports.verdict })
      .from(parityReports);

    const snapshotByRun = new Map(snapshots.map((s) => [s.runId, s]));
    const parityByRun = new Map(parities.map((p) => [p.runId, p.verdict]));

    const markets = new Map<
      string,
      {
        symbol: string;
        timeframe: string;
        runs: number;
        outOfSampleRuns: number;
        outOfSampleProfitable: number;
        closedTrades: number;
        winRateWeightedSum: number;
        winRateWeight: number;
        anyParityFail: boolean;
        hasTradingViewEvidence: boolean;
        sources: Set<string>;
      }
    >();

    for (const row of rows) {
      const key = `${row.symbol}|${row.timeframe}`;
      const entry = markets.get(key) ?? {
        symbol: row.symbol,
        timeframe: row.timeframe,
        runs: 0,
        outOfSampleRuns: 0,
        outOfSampleProfitable: 0,
        closedTrades: 0,
        winRateWeightedSum: 0,
        winRateWeight: 0,
        anyParityFail: false,
        hasTradingViewEvidence: false,
        sources: new Set<string>(),
      };

      entry.runs += 1;
      entry.sources.add(row.source);
      if (row.source === 'tradingview_csv') entry.hasTradingViewEvidence = true;
      if (parityByRun.get(row.runId) === 'FAIL') entry.anyParityFail = true;

      const snapshot = snapshotByRun.get(row.runId);
      if (snapshot) {
        const values = snapshot.metrics as Record<string, unknown>;
        const trades = Number(values['closedTradeCount'] ?? 0);
        const winRate = values['winRatePct'];

        entry.closedTrades += Number.isFinite(trades) ? trades : 0;

        // Weighted by trade count: a fold with three trades should not move
        // the aggregate as much as one with sixty.
        if (typeof winRate === 'number' && Number.isFinite(winRate) && trades > 0) {
          entry.winRateWeightedSum += winRate * trades;
          entry.winRateWeight += trades;
        }

        if (snapshot.scope === 'OUT_OF_SAMPLE') {
          entry.outOfSampleRuns += 1;
          const net = Number(values['netProfit'] ?? 0);
          if (Number.isFinite(net) && net > 0) entry.outOfSampleProfitable += 1;
        }
      }

      markets.set(key, entry);
    }

    const items = [...markets.values()].map((m) => {
      // Every gate must hold. These are the same conditions the workflow
      // engine applies at promotion, reported here rather than re-invented.
      // Every threshold is the operator's, read from the signed mandate.
      // Section 26.6: an agent may not infer or widen these.
      const foldRatio =
        m.outOfSampleRuns > 0 ? m.outOfSampleProfitable / m.outOfSampleRuns : 0;
      const winRate = m.winRateWeight > 0 ? m.winRateWeightedSum / m.winRateWeight : null;

      const gates = {
        hasOutOfSample: thresholds.requireOutOfSample ? m.outOfSampleRuns > 0 : true,
        foldsProfitableRatio: foldRatio >= thresholds.minFoldsProfitableRatio,
        parityNotFailing: thresholds.requireParityNotFailing ? !m.anyParityFail : true,
        meetsMinimumTrades: m.closedTrades >= thresholds.minClosedTrades,
        meetsMinimumWinRate: winRate !== null && winRate >= thresholds.minWinRatePct,
        hasTradingViewEvidence: thresholds.requireTradingViewEvidence
          ? m.hasTradingViewEvidence
          : true,
      };

      return {
        symbol: m.symbol,
        timeframe: m.timeframe,
        runs: m.runs,
        sources: [...m.sources].sort(),
        outOfSampleRuns: m.outOfSampleRuns,
        outOfSampleProfitable: m.outOfSampleProfitable,
        closedTrades: m.closedTrades,
        // Null, not zero, when nothing supplied a rate: unknown is not 0%.
        winRatePct: winRate,
        gates,
        meetsEvidenceBar: Object.values(gates).every(Boolean),
      };
    });

    return reply.send({
      items: items.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      thresholds,
      mandateVersion,
      note:
        'meetsEvidenceBar reports whether stored evidence clears the thresholds recorded in the operator mandate. It is not investment advice, and no value here authorises deploying capital.',
      generatedAt: new Date().toISOString(),
    });
  });
}
