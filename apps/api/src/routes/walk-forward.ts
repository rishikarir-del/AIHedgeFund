/**
 * Walk-forward request endpoint.
 *
 * A sweep is eighteen backtests and takes minutes, so this enqueues a job and
 * returns 202 rather than holding the request open. CLAUDE.md 16.1 makes the
 * same point about webhooks: accept, enqueue, return quickly.
 *
 * Section 3.2 keeps the lifecycle out of here. The job writes evidence; moving
 * the version afterwards is a separate, human-approved decision.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JobQueue } from '@arf/event-bus';
import { pineRevisions, strategyVersions, type Database } from '@arf/db';
import { Errors } from '../errors.js';
import { guard, parseBody } from '../lib/guards.js';
import { claimIdempotencyKey, recordIdempotentResult } from '../plugins/idempotency.js';

export const WALK_FORWARD_QUEUE = 'walk-forward';

const RequestBody = z.object({
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  from: z.iso.date(),
  to: z.iso.date(),
  initialCapital: z.string().regex(/^\d+(\.\d+)?$/),
  model: z
    .enum(['rolling_walk_forward', 'anchored_walk_forward', 'fixed_split'])
    .default('rolling_walk_forward'),
  inSampleDays: z.number().int().positive().default(90),
  outOfSampleDays: z.number().int().positive().default(30),
  // Zero is rejected by the planner too; stating it here gives a 422 with a
  // field-level message rather than a 500 from deeper in.
  embargoDays: z.number().int().positive().default(5),
  /** Hard credit ceiling. Required: a sweep must never cost more than asked. */
  maxRuns: z.number().int().positive().max(200),
});

export function registerWalkForwardRoutes(
  app: FastifyInstance,
  db: Database,
  queue: JobQueue | undefined,
): void {
  app.post<{ Params: { id: string } }>('/v1/versions/:id/walk-forward', async (request, reply) => {
    const actor = guard(request, 'backtest:run');
    const body = parseBody(RequestBody, request.body);

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

    // The sweep runs the version's stored Pine, not source supplied with the
    // request. Otherwise the evidence would attach to a version it was not
    // produced from, which breaks the lineage 3.1 exists to guarantee.
    const [revision] = await db
      .select()
      .from(pineRevisions)
      .where(eq(pineRevisions.strategyVersionId, request.params.id))
      .limit(1);
    if (!revision) {
      throw Errors.policyRejected(
        'no_pine_revision',
        'This version has no stored Pine revision, so there is nothing to test.',
      );
    }

    if (!queue) {
      throw Errors.policyRejected(
        'queue_unavailable',
        'No job queue is configured, so a walk-forward cannot be scheduled.',
      );
    }

    const key = request.headers['idempotency-key'];
    const idempotencyKey = typeof key === 'string' ? key : undefined;
    const claim = await claimIdempotencyKey(db, actor, idempotencyKey, body);
    if (claim.replayOf) {
      return reply.code(200).send({ jobId: claim.replayOf, replay: true });
    }

    // Deterministic id: re-requesting the same sweep for the same version is
    // the same job, not a second one costing another eighteen credits.
    const jobId = `wf-${request.params.id}-${body.from}-${body.to}-${body.timeframe}`;

    await queue.enqueue(WALK_FORWARD_QUEUE, {
      jobId,
      payload: {
        strategyVersionId: version.id,
        organisationId: actor.organisationId,
        artefactKey: revision.artefactKey,
        sourceHash: revision.sourceHash,
        ...body,
      },
    });

    await recordIdempotentResult(db, actor, idempotencyKey, jobId);

    return reply.code(202).send({
      jobId,
      status: 'queued',
      estimatedRuns: 'computed by the worker from the segment plan',
      note: 'Evidence is written per fold. This does not move the version state.',
    });
  });
}
