/**
 * Strategy, version, SDL and Pine revision routes.
 *
 * CLAUDE.md 3.1 is the rule that shapes these: a tested strategy version is
 * never mutated. There is deliberately no PATCH or PUT on a version, on its
 * definition, or on a Pine revision. Changing any of them means creating a
 * child version, which is what POST /versions does.
 */
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StrategyDefinitionSchema } from '@arf/contracts';
import {
  pineRevisions,
  strategies,
  strategyDefinitions,
  strategyLineage,
  strategyVersions,
  type Database,
} from '@arf/db';
import { hashPineSource, hashManifest, lintPineSource, hasBlockingFindings } from '@arf/pine';
import { Errors } from '../errors.js';
import { guard, parseBody } from '../lib/guards.js';
import { claimIdempotencyKey, recordIdempotentResult } from '../plugins/idempotency.js';
import { buildPage, parsePageRequest } from '../pagination.js';

const CreateStrategyBody = z.object({
  campaignId: z.string().uuid(),
  name: z.string().min(1).max(255),
  family: z.string().min(1),
});

const CreateVersionBody = z.object({
  /** Omitted for a first version; set when superseding an existing one. */
  parentVersionId: z.string().uuid().optional(),
  reason: z.string().min(1),
  definition: StrategyDefinitionSchema,
});

const CreatePineRevisionBody = z.object({
  source: z.string().min(1),
  manifest: z.record(z.string(), z.unknown()),
  artefactKey: z.string().min(1),
});

function idempotencyKeyOf(headers: Record<string, unknown>): string | undefined {
  const key = headers['idempotency-key'];
  return typeof key === 'string' ? key : undefined;
}

export function registerStrategyRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/strategies', async (request, reply) => {
    const actor = guard(request, 'strategy:read');
    const page = parsePageRequest(request.query as Record<string, string | undefined>);

    // Newest first. UUIDv7 sorts chronologically, so descending id is
    // descending creation time and the cursor walks backwards with `lt`.
    // Ascending would push the most recent work off the end of the first page,
    // which is exactly the work a researcher is looking for.
    const rows = await db
      .select()
      .from(strategies)
      .where(
        page.after
          ? and(eq(strategies.organisationId, actor.organisationId), lt(strategies.id, page.after))
          : eq(strategies.organisationId, actor.organisationId),
      )
      .orderBy(desc(strategies.id))
      .limit(page.limit + 1);

    return reply.send(buildPage(rows, page.limit));
  });

  app.post('/v1/strategies', async (request, reply) => {
    const actor = guard(request, 'strategy:create');
    const body = parseBody(CreateStrategyBody, request.body);
    const key = idempotencyKeyOf(request.headers as Record<string, unknown>);

    const claim = await claimIdempotencyKey(db, actor, key, body);
    if (claim.replayOf) {
      const existing = await db.select().from(strategies).where(eq(strategies.id, claim.replayOf)).limit(1);
      if (existing[0]) return reply.code(200).send(existing[0]);
    }

    const [created] = await db
      .insert(strategies)
      .values({
        organisationId: actor.organisationId,
        campaignId: body.campaignId,
        name: body.name,
        family: body.family,
      })
      .returning();
    if (!created) throw new Error('Insert returned no row');

    await recordIdempotentResult(db, actor, key, created.id);
    return reply.code(201).send(created);
  });

  app.get<{ Params: { id: string } }>('/v1/strategies/:id/versions', async (request, reply) => {
    const actor = guard(request, 'strategy:read');

    const rows = await db
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.strategyId, request.params.id),
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      )
      .orderBy(asc(strategyVersions.versionNumber));

    return reply.send({ items: rows, nextCursor: null });
  });

  /**
   * Creates a version. This is the only way to change anything about a
   * strategy: 3.1 lists source, definition, parameters, symbol, timeframe,
   * costs, sizing and execution settings as changes that all require a new row.
   */
  app.post<{ Params: { id: string } }>('/v1/strategies/:id/versions', async (request, reply) => {
    const actor = guard(request, 'strategy_version:create');
    const body = parseBody(CreateVersionBody, request.body);

    const parent = await db
      .select()
      .from(strategies)
      .where(and(eq(strategies.id, request.params.id), eq(strategies.organisationId, actor.organisationId)))
      .limit(1);
    if (!parent[0]) throw Errors.notFound('Strategy');

    const existing = await db
      .select({ versionNumber: strategyVersions.versionNumber })
      .from(strategyVersions)
      .where(eq(strategyVersions.strategyId, request.params.id));
    const nextNumber = existing.reduce((max, r) => Math.max(max, r.versionNumber), 0) + 1;

    const definitionHash = hashManifest(body.definition as unknown as Record<string, unknown>);

    // Version, definition and lineage are written together: 9.3 requires
    // strategy-version creation plus lineage to share a transaction.
    const created = await db.transaction(async (tx) => {
      const [version] = await tx
        .insert(strategyVersions)
        .values({
          organisationId: actor.organisationId,
          strategyId: request.params.id,
          versionNumber: nextNumber,
          definitionHash,
        })
        .returning();
      if (!version) throw new Error('Insert returned no row');

      await tx.insert(strategyDefinitions).values({
        strategyVersionId: version.id,
        schemaVersion: body.definition.schemaVersion,
        document: body.definition,
      });

      if (body.parentVersionId) {
        await tx.insert(strategyLineage).values({
          childVersionId: version.id,
          parentVersionId: body.parentVersionId,
          reason: body.reason,
        });
      }

      return version;
    });

    return reply.code(201).send(created);
  });

  app.get<{ Params: { id: string } }>('/v1/versions/:id/definition', async (request, reply) => {
    const actor = guard(request, 'strategy:read');

    const version = await db
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.id, request.params.id),
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      )
      .limit(1);
    if (!version[0]) throw Errors.notFound('Strategy version');

    const rows = await db
      .select()
      .from(strategyDefinitions)
      .where(eq(strategyDefinitions.strategyVersionId, request.params.id))
      .limit(1);
    if (!rows[0]) throw Errors.notFound('Strategy definition');

    return reply.send(rows[0]);
  });

  /**
   * Stores a Pine revision. The linter runs first: 12.2 treats lookahead,
   * negative offsets and a missing cost model as hard errors, so a script that
   * repaints never becomes evidence in the first place.
   */
  app.post<{ Params: { id: string } }>('/v1/versions/:id/pine-revisions', async (request, reply) => {
    const actor = guard(request, 'pine:write');
    const body = parseBody(CreatePineRevisionBody, request.body);

    const version = await db
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.id, request.params.id),
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      )
      .limit(1);
    if (!version[0]) throw Errors.notFound('Strategy version');

    const findings = lintPineSource(body.source);
    if (hasBlockingFindings(findings)) {
      throw Errors.policyRejected(
        'pine_lint_failed',
        `Static checks failed: ${findings
          .filter((f) => f.severity === 'error')
          .map((f) => f.code)
          .join(', ')}.`,
      );
    }

    const sourceHash = hashPineSource(body.source);
    const manifestHash = hashManifest(body.manifest);

    const [created] = await db
      .insert(pineRevisions)
      .values({
        strategyVersionId: request.params.id,
        sourceHash,
        manifestHash,
        artefactKey: body.artefactKey,
      })
      .returning();

    return reply.code(201).send({ ...created, warnings: findings });
  });

  app.get<{ Params: { id: string } }>('/v1/versions/:id/pine-revisions', async (request, reply) => {
    const actor = guard(request, 'strategy:read');

    const version = await db
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.id, request.params.id),
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      )
      .limit(1);
    if (!version[0]) throw Errors.notFound('Strategy version');

    const rows = await db
      .select()
      .from(pineRevisions)
      .where(eq(pineRevisions.strategyVersionId, request.params.id))
      .orderBy(asc(pineRevisions.id));

    return reply.send({ items: rows, nextCursor: null });
  });
}
