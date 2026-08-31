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
  campaigns,
  committeeDecisions,
  outboxEvents,
  strategies,
  strategyVersions,
  tradingviewVerifications,
  type Database,
} from '@arf/db';
import { guard } from '../lib/guards.js';

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
