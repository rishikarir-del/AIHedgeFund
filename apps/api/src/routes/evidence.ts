/**
 * Evidence routes: trades, equity, metrics and parity.
 *
 * CLAUDE.md 3.5 makes final-holdout and forward results protected: they need
 * a role AND stage check, and every read writes an audit event. The metrics
 * route therefore goes through `authoriseHoldoutRead` rather than the plain
 * capability guard, and records the read when it succeeds.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authoriseHoldoutRead, type EvidenceStage } from '@arf/auth';
import {
  auditEvents,
  backtestRuns,
  equityPoints,
  metricSnapshots,
  parityReports,
  trades,
  type Database,
} from '@arf/db';
import { Errors } from '../errors.js';
import { guard } from '../lib/guards.js';
import { requireActor } from '../plugins/auth.js';
import { buildPage, parsePageRequest } from '../pagination.js';

async function requireRun(db: Database, runId: string, organisationId: string) {
  const rows = await db
    .select()
    .from(backtestRuns)
    .where(and(eq(backtestRuns.id, runId), eq(backtestRuns.organisationId, organisationId)))
    .limit(1);
  if (!rows[0]) throw Errors.notFound('Backtest run');
  return rows[0];
}

export function registerEvidenceRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>('/v1/backtest-runs/:id', async (request, reply) => {
    const actor = guard(request, 'strategy:read');
    return reply.send(await requireRun(db, request.params.id, actor.organisationId));
  });

  app.get<{ Params: { id: string } }>('/v1/backtest-runs/:id/trades', async (request, reply) => {
    const actor = guard(request, 'strategy:read');
    await requireRun(db, request.params.id, actor.organisationId);

    const page = parsePageRequest(request.query as Record<string, string | undefined>);
    const rows = await db
      .select()
      .from(trades)
      .where(
        page.after
          ? and(eq(trades.runId, request.params.id), gt(trades.id, page.after))
          : eq(trades.runId, request.params.id),
      )
      .orderBy(asc(trades.sequence))
      .limit(page.limit + 1);

    return reply.send(buildPage(rows, page.limit));
  });

  app.get<{ Params: { id: string } }>('/v1/backtest-runs/:id/equity', async (request, reply) => {
    const actor = guard(request, 'strategy:read');
    await requireRun(db, request.params.id, actor.organisationId);

    const rows = await db
      .select()
      .from(equityPoints)
      .where(eq(equityPoints.runId, request.params.id))
      .orderBy(asc(equityPoints.barTime));

    return reply.send({ items: rows, nextCursor: null });
  });

  /**
   * Metrics are stage-scoped. A FINAL_HOLDOUT snapshot requires the holdout
   * capability and completed validation, and the read is audited (3.5).
   */
  app.get<{ Params: { id: string }; Querystring: { stage?: string } }>(
    '/v1/backtest-runs/:id/metrics',
    async (request, reply) => {
      const actor = requireActor(request);
      const run = await requireRun(db, request.params.id, actor.organisationId);

      const stage = (request.query.stage ?? 'IN_SAMPLE') as EvidenceStage;

      // Validation completion is derived from the presence of a parity report
      // for the run, which is the gate the workflow uses too.
      const parity = await db
        .select()
        .from(parityReports)
        .where(eq(parityReports.runId, request.params.id))
        .limit(1);

      const decision = authoriseHoldoutRead({
        actor,
        resourceOrganisationId: run.organisationId,
        stage,
        validationComplete: parity.length > 0,
      });
      if (!decision.allowed) throw Errors.forbidden(decision.code, decision.reason);

      const rows = await db
        .select()
        .from(metricSnapshots)
        .where(
          and(eq(metricSnapshots.runId, request.params.id), eq(metricSnapshots.scope, stage)),
        );

      if (decision.requiresAudit) {
        await db.insert(auditEvents).values({
          organisationId: actor.organisationId,
          actor: actor.userId,
          action: 'protected_data.read',
          aggregate: 'metric_snapshot',
          aggregateId: request.params.id,
          newState: { stage },
          reason: 'Protected evidence read',
          traceId: actor.traceId,
        });
      }

      return reply.send({ items: rows, nextCursor: null });
    },
  );

  app.get<{ Params: { id: string } }>('/v1/backtest-runs/:id/parity', async (request, reply) => {
    const actor = guard(request, 'strategy:read');
    await requireRun(db, request.params.id, actor.organisationId);

    const rows = await db
      .select()
      .from(parityReports)
      .where(eq(parityReports.runId, request.params.id))
      .limit(1);
    if (!rows[0]) throw Errors.notFound('Parity report');

    return reply.send(rows[0]);
  });
}
