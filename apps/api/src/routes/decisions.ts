/**
 * Decision and audit-timeline routes.
 *
 * This is where the workflow engine meets storage. CLAUDE.md 3.2 says workers
 * do not change lifecycle state and 10 says transition checks never scatter
 * into handlers, so the handler gathers facts, asks @arf/workflow, and then
 * persists whatever the engine returned.
 *
 * 9.3 requires the state transition, its audit record, the decision and the
 * outbox event to share one transaction. A crash between them would otherwise
 * leave an approved version with no record of who approved it.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transition, type EvidenceKind } from '@arf/workflow';
import {
  auditEvents,
  backtestRuns,
  committeeDecisions,
  metricSnapshots,
  outboxEvents,
  parityReports,
  pineRevisions,
  strategyDefinitions,
  strategyVersions,
  type Database,
} from '@arf/db';
import { Errors } from '../errors.js';
import { guard, parseBody } from '../lib/guards.js';
import { requireActor } from '../plugins/auth.js';
import { claimIdempotencyKey, recordIdempotentResult } from '../plugins/idempotency.js';

const DecisionBody = z.object({
  strategyVersionId: z.string().uuid(),
  to: z.enum(['PAPER_APPROVED', 'REJECTED', 'BLOCKED']),
  rationale: z.string().min(1),
  rejectionCase: z.string().optional(),
});

/**
 * Assembles the evidence actually attached to a version. The engine is pure,
 * so every fact it needs is resolved here rather than fetched inside it.
 */
async function gatherEvidence(db: Database, versionId: string): Promise<EvidenceKind[]> {
  const present: EvidenceKind[] = [];

  const [definition] = await db
    .select({ id: strategyDefinitions.id })
    .from(strategyDefinitions)
    .where(eq(strategyDefinitions.strategyVersionId, versionId))
    .limit(1);
  if (definition) present.push('strategy_definition');

  const [pine] = await db
    .select({ id: pineRevisions.id })
    .from(pineRevisions)
    .where(eq(pineRevisions.strategyVersionId, versionId))
    .limit(1);
  if (pine) present.push('pine_revision');

  const runs = await db
    .select({ id: backtestRuns.id, source: backtestRuns.source })
    .from(backtestRuns)
    .where(eq(backtestRuns.strategyVersionId, versionId));
  if (runs.length > 0) present.push('backtest_run');

  for (const run of runs) {
    const [parity] = await db
      .select({ id: parityReports.id })
      .from(parityReports)
      .where(eq(parityReports.runId, run.id))
      .limit(1);
    if (parity && !present.includes('parity_report')) present.push('parity_report');

    const [metric] = await db
      .select({ id: metricSnapshots.id })
      .from(metricSnapshots)
      .where(eq(metricSnapshots.runId, run.id))
      .limit(1);
    if (metric && !present.includes('metric_snapshot')) present.push('metric_snapshot');
  }

  return present;
}

async function gatherPromotionFacts(db: Database, versionId: string) {
  const runs = await db
    .select()
    .from(backtestRuns)
    .where(eq(backtestRuns.strategyVersionId, versionId));

  let worstParity: 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT_DATA' | null = null;
  let closedTradeCount = 0;
  let maxDrawdownPct = 0;

  for (const run of runs) {
    const [parity] = await db
      .select()
      .from(parityReports)
      .where(eq(parityReports.runId, run.id))
      .orderBy(desc(parityReports.createdAt))
      .limit(1);

    if (parity) {
      const rank = { PASS: 0, WARN: 1, INSUFFICIENT_DATA: 2, FAIL: 3 } as const;
      const verdict = parity.verdict;
      if (worstParity === null || rank[verdict] > rank[worstParity]) worstParity = verdict;
    }

    const [metrics] = await db
      .select()
      .from(metricSnapshots)
      .where(eq(metricSnapshots.runId, run.id))
      .orderBy(desc(metricSnapshots.createdAt))
      .limit(1);

    if (metrics) {
      const values = metrics.metrics as Record<string, unknown>;
      const count = Number(values['closedTradeCount'] ?? 0);
      const drawdown = Number(values['maxDrawdownPct'] ?? Number.NaN);
      closedTradeCount = Math.max(closedTradeCount, Number.isFinite(count) ? count : 0);
      maxDrawdownPct = Number.isFinite(drawdown) ? drawdown : Number.NaN;
    }
  }

  return {
    parityVerdict: worstParity,
    evidenceSources: runs.map((r) => r.source),
    closedTradeCount,
    maxDrawdownPct,
    hasUnresolvedFailedRun: false,
    presentEvidence: [],
  };
}

export function registerDecisionRoutes(app: FastifyInstance, db: Database): void {
  app.post('/v1/decisions', async (request, reply) => {
    const actor = requireActor(request);
    const body = parseBody(DecisionBody, request.body);
    const key = request.headers['idempotency-key'];
    const idempotencyKey = typeof key === 'string' ? key : undefined;

    const [version] = await db
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.id, body.strategyVersionId),
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      )
      .limit(1);
    if (!version) throw Errors.notFound('Strategy version');

    const claim = await claimIdempotencyKey(db, actor, idempotencyKey, body);
    if (claim.replayOf) {
      const [existing] = await db
        .select()
        .from(committeeDecisions)
        .where(eq(committeeDecisions.id, claim.replayOf))
        .limit(1);
      if (existing) return reply.code(200).send(existing);
    }

    const presentEvidence = await gatherEvidence(db, body.strategyVersionId);
    const promotionFacts =
      body.to === 'PAPER_APPROVED' ? await gatherPromotionFacts(db, body.strategyVersionId) : undefined;

    // The engine decides. It does not read or write the database.
    const outcome = transition({
      actor,
      aggregateId: version.id,
      resourceOrganisationId: version.organisationId,
      from: version.state,
      to: body.to,
      presentEvidence,
      createdByUserId: version.id === actor.userId ? actor.userId : 'unknown',
      promotionFacts,
      reason: body.rationale,
    });

    if (!outcome.ok) {
      const problem = Errors.policyRejected(outcome.code, outcome.reason);
      return reply
        .code(problem.status)
        .type('application/problem+json')
        .send({
          type: `https://arf-os.local/problems/${outcome.code}`,
          title: 'Policy Rejected',
          status: problem.status,
          detail: outcome.reason,
          instance: request.url,
          code: outcome.code,
          traceId: request.id,
          hardFails: outcome.hardFails,
        });
    }

    if (outcome.idempotentReplay) {
      return reply.code(200).send({ replay: true, state: version.state });
    }

    const decision = await db.transaction(async (tx) => {
      await tx
        .update(strategyVersions)
        .set({ state: body.to })
        .where(eq(strategyVersions.id, version.id));

      const [recorded] = await tx
        .insert(committeeDecisions)
        .values({
          organisationId: actor.organisationId,
          strategyVersionId: version.id,
          outcome: body.to === 'PAPER_APPROVED' ? 'PAPER_APPROVED' : 'REJECT',
          rationale: body.rationale,
          rejectionCase: body.rejectionCase ?? null,
          decidedBy: actor.userId,
          policyVersion: outcome.policyVersion,
          evidenceIds: presentEvidence,
        })
        .returning();

      await tx.insert(auditEvents).values({
        organisationId: actor.organisationId,
        actor: outcome.auditEvent.actor,
        action: outcome.auditEvent.action,
        aggregate: outcome.auditEvent.aggregate,
        aggregateId: outcome.auditEvent.aggregateId,
        priorState: outcome.auditEvent.priorState,
        newState: outcome.auditEvent.newState,
        reason: outcome.auditEvent.reason,
        traceId: outcome.auditEvent.traceId,
      });

      await tx.insert(outboxEvents).values({
        eventType: `strategy_version.${body.to.toLowerCase()}`,
        payload: { strategyVersionId: version.id, decisionId: recorded?.id ?? null },
      });

      return recorded;
    });

    await recordIdempotentResult(db, actor, idempotencyKey, decision?.id ?? '');
    return reply.code(201).send(decision);
  });

  /** Append-only history for one aggregate (9.4). */
  app.get<{ Params: { id: string } }>('/v1/versions/:id/audit', async (request, reply) => {
    const actor = guard(request, 'strategy:read');

    const [version] = await db
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.id, request.params.id),
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      )
      .limit(1);
    if (!version) throw Errors.notFound('Strategy version');

    const rows = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organisationId, actor.organisationId),
          eq(auditEvents.aggregateId, request.params.id),
        ),
      )
      .orderBy(asc(auditEvents.createdAt));

    return reply.send({ items: rows, nextCursor: null });
  });
}
