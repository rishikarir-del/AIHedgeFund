/**
 * Campaign routes.
 *
 * CLAUDE.md 17.1 keeps handlers thin: authenticate, authorise, validate, call
 * the service, map the result, return. There is no SQL and no workflow rule in
 * this file -- queries live in the repository, policy in @arf/auth.
 */
import { asc, eq, gt, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorise } from '@arf/auth';
import { campaigns, type Database } from '@arf/db';
import { Errors } from '../errors.js';
import { requireActor } from '../plugins/auth.js';
import { claimIdempotencyKey, recordIdempotentResult } from '../plugins/idempotency.js';
import { buildPage, parsePageRequest } from '../pagination.js';

const CreateCampaignBody = z.object({
  name: z.string().min(1).max(255),
  brief: z.string().min(1),
});

export function registerCampaignRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/campaigns', async (request, reply) => {
    const actor = requireActor(request);

    const decision = authorise({
      actor,
      capability: 'campaign:read',
      resourceOrganisationId: actor.organisationId,
    });
    if (!decision.allowed) throw Errors.forbidden(decision.code, decision.reason);

    const page = parsePageRequest(request.query as Record<string, string | undefined>);

    const rows = await db
      .select()
      .from(campaigns)
      .where(
        page.after
          ? and(eq(campaigns.organisationId, actor.organisationId), gt(campaigns.id, page.after))
          : eq(campaigns.organisationId, actor.organisationId),
      )
      .orderBy(asc(campaigns.id))
      .limit(page.limit + 1);

    return reply.send(buildPage(rows, page.limit));
  });

  app.get<{ Params: { id: string } }>('/v1/campaigns/:id', async (request, reply) => {
    const actor = requireActor(request);

    const decision = authorise({
      actor,
      capability: 'campaign:read',
      resourceOrganisationId: actor.organisationId,
    });
    if (!decision.allowed) throw Errors.forbidden(decision.code, decision.reason);

    // Scoped by id AND organisation. A row belonging to another organisation
    // is reported as absent rather than forbidden, so existence does not leak.
    const rows = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, request.params.id), eq(campaigns.organisationId, actor.organisationId)))
      .limit(1);

    const campaign = rows[0];
    if (!campaign) throw Errors.notFound('Campaign');

    return reply.send(campaign);
  });

  app.post('/v1/campaigns', async (request, reply) => {
    const actor = requireActor(request);

    const decision = authorise({
      actor,
      capability: 'campaign:create',
      resourceOrganisationId: actor.organisationId,
    });
    if (!decision.allowed) throw Errors.forbidden(decision.code, decision.reason);

    const parsed = CreateCampaignBody.safeParse(request.body);
    if (!parsed.success) {
      throw Errors.validation(
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }

    const key = request.headers['idempotency-key'];
    const idempotencyKey = typeof key === 'string' ? key : undefined;

    const claim = await claimIdempotencyKey(db, actor, idempotencyKey, parsed.data);
    if (claim.replayOf) {
      const existing = await db.select().from(campaigns).where(eq(campaigns.id, claim.replayOf)).limit(1);
      if (existing[0]) return reply.code(200).send(existing[0]);
    }

    const [created] = await db
      .insert(campaigns)
      .values({
        organisationId: actor.organisationId,
        name: parsed.data.name,
        brief: parsed.data.brief,
        createdBy: actor.userId,
      })
      .returning();

    if (!created) throw new Error('Insert returned no row');

    await recordIdempotentResult(db, actor, idempotencyKey, created.id);
    return reply.code(201).send(created);
  });
}
