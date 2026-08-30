/**
 * TradingView verification routes.
 *
 * CLAUDE.md 15.1 requires presigned uploads with validated type, size and
 * checksum, and the raw upload preserved by checksum. The API never receives
 * file bytes: it issues a ticket, the client uploads directly to object
 * storage, and completion is a separate call that verifies what landed.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  artefacts,
  reportUploads,
  strategyVersions,
  tradingviewVerifications,
  type Database,
  type ObjectStore,
} from '@arf/db';
import { Errors } from '../errors.js';
import { guard, parseBody } from '../lib/guards.js';

const CreateVerificationBody = z.object({
  strategyVersionId: z.string().uuid(),
  requiredSymbol: z.string().min(1),
  requiredTimeframe: z.string().min(1),
  requiredSourceHash: z.string().regex(/^[0-9a-f]{64}$/i),
});

const UploadTicketBody = z.object({
  reportType: z.enum(['performance_summary', 'list_of_trades']),
  checksum: z.string().regex(/^[0-9a-f]{64}$/i),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

const CompleteUploadBody = z.object({
  reportType: z.enum(['performance_summary', 'list_of_trades']),
  checksum: z.string().regex(/^[0-9a-f]{64}$/i),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});

export function registerVerificationRoutes(
  app: FastifyInstance,
  db: Database,
  store: ObjectStore,
  validateUpload: typeof import('@arf/db').validateUpload,
  deriveObjectKey: typeof import('@arf/db').deriveObjectKey,
): void {
  app.post('/v1/tradingview-verifications', async (request, reply) => {
    const actor = guard(request, 'verification:upload');
    const body = parseBody(CreateVerificationBody, request.body);

    const version = await db
      .select()
      .from(strategyVersions)
      .where(
        and(
          eq(strategyVersions.id, body.strategyVersionId),
          eq(strategyVersions.organisationId, actor.organisationId),
        ),
      )
      .limit(1);
    if (!version[0]) throw Errors.notFound('Strategy version');

    const [created] = await db
      .insert(tradingviewVerifications)
      .values({
        organisationId: actor.organisationId,
        strategyVersionId: body.strategyVersionId,
        requiredSymbol: body.requiredSymbol,
        requiredTimeframe: body.requiredTimeframe,
        requiredSourceHash: body.requiredSourceHash,
        status: 'AWAITING_UPLOAD',
      })
      .returning();

    return reply.code(201).send(created);
  });

  app.get<{ Params: { id: string } }>(
    '/v1/tradingview-verifications/:id',
    async (request, reply) => {
      const actor = guard(request, 'strategy:read');

      const rows = await db
        .select()
        .from(tradingviewVerifications)
        .where(
          and(
            eq(tradingviewVerifications.id, request.params.id),
            eq(tradingviewVerifications.organisationId, actor.organisationId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw Errors.notFound('Verification');

      const uploads = await db
        .select()
        .from(reportUploads)
        .where(eq(reportUploads.verificationId, request.params.id))
        .orderBy(asc(reportUploads.id));

      return reply.send({ ...rows[0], uploads });
    },
  );

  /** Issues a presigned PUT. The key is derived, never supplied (section 19). */
  app.post<{ Params: { id: string } }>(
    '/v1/tradingview-verifications/:id/upload-ticket',
    async (request, reply) => {
      const actor = guard(request, 'verification:upload');
      const body = parseBody(UploadTicketBody, request.body);

      const rows = await db
        .select()
        .from(tradingviewVerifications)
        .where(
          and(
            eq(tradingviewVerifications.id, request.params.id),
            eq(tradingviewVerifications.organisationId, actor.organisationId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw Errors.notFound('Verification');

      const problems = validateUpload({
        kind: 'tradingview_export',
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
      });
      if (problems.length > 0) {
        throw Errors.policyRejected(
          problems[0]!.code,
          problems.map((problem) => problem.detail).join(' '),
        );
      }

      const ticket = await store.createUploadTicket({
        organisationId: actor.organisationId,
        kind: 'tradingview_export',
        checksum: body.checksum,
        contentType: body.contentType,
      });

      return reply.send(ticket);
    },
  );

  /**
   * Confirms an upload landed and matches its declared checksum. The key IS
   * the checksum, so a mismatch means the artefact is not what it claims.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/tradingview-verifications/:id/uploads',
    async (request, reply) => {
      const actor = guard(request, 'verification:upload');
      const body = parseBody(CompleteUploadBody, request.body);

      const rows = await db
        .select()
        .from(tradingviewVerifications)
        .where(
          and(
            eq(tradingviewVerifications.id, request.params.id),
            eq(tradingviewVerifications.organisationId, actor.organisationId),
          ),
        )
        .limit(1);
      if (!rows[0]) throw Errors.notFound('Verification');

      const objectKey = deriveObjectKey(actor.organisationId, 'tradingview_export', body.checksum);

      if (!(await store.objectExists(objectKey))) {
        throw Errors.policyRejected('upload_not_found', 'No object exists at the expected key.');
      }
      if (!(await store.verifyUpload(objectKey, body.checksum))) {
        throw Errors.policyRejected(
          'checksum_mismatch',
          'Uploaded content does not match the declared checksum.',
        );
      }

      const result = await db.transaction(async (tx) => {
        const [artefact] = await tx
          .insert(artefacts)
          .values({
            organisationId: actor.organisationId,
            kind: 'tradingview_export',
            objectKey,
            checksum: body.checksum,
            sizeBytes: body.sizeBytes,
            contentType: body.contentType,
          })
          .onConflictDoNothing()
          .returning();

        // onConflictDoNothing returns nothing when the artefact already
        // exists, which is the deduplication path rather than an error.
        const artefactId =
          artefact?.id ??
          (
            await tx
              .select()
              .from(artefacts)
              .where(
                and(
                  eq(artefacts.organisationId, actor.organisationId),
                  eq(artefacts.checksum, body.checksum),
                ),
              )
              .limit(1)
          )[0]?.id;
        if (!artefactId) throw new Error('Artefact could not be resolved after insert');

        const [upload] = await tx
          .insert(reportUploads)
          .values({
            verificationId: request.params.id,
            artefactId,
            reportType: body.reportType,
          })
          .onConflictDoNothing()
          .returning();

        await tx
          .update(tradingviewVerifications)
          .set({ status: 'PARSED' })
          .where(eq(tradingviewVerifications.id, request.params.id));

        return upload;
      });

      return reply.code(201).send(result ?? { deduplicated: true });
    },
  );
}
