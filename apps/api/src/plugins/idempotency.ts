/**
 * Idempotency-Key handling.
 *
 * CLAUDE.md 17.5: persist the key, actor and request hash, and reject reuse
 * with a different request body. 3.6 requires every side-effecting command to
 * be idempotent, so this is applied to commands rather than left to callers.
 *
 * Storing the request hash rather than only the key is what makes reuse
 * detectable: the same key with the same body is a retry and should replay,
 * while the same key with a different body is a client bug and must not
 * silently perform a second, different action.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Actor } from '@arf/auth';
import { idempotencyRecords, type Database } from '@arf/db';
import { Errors } from '../errors.js';

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export interface IdempotencyOutcome {
  /** Set when this key and body were seen before; the caller should replay. */
  readonly replayOf: string | null;
}

/**
 * Claims an idempotency key for this actor and body.
 *
 * Returns `replayOf` when the identical command was already accepted, so the
 * caller can return the original result rather than acting twice. Throws a
 * 409 when the key was used with a different body.
 */
export async function claimIdempotencyKey(
  db: Database,
  actor: Actor,
  key: string | undefined,
  body: unknown,
): Promise<IdempotencyOutcome> {
  if (!key) return { replayOf: null };

  const requestHash = hashRequest(body);

  const existing = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.organisationId, actor.organisationId),
        eq(idempotencyRecords.idempotencyKey, key),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (row) {
    if (row.requestHash !== requestHash) throw Errors.idempotencyConflict();
    return { replayOf: row.responseReference };
  }

  try {
    await db.insert(idempotencyRecords).values({
      organisationId: actor.organisationId,
      idempotencyKey: key,
      actor: actor.userId,
      requestHash,
    });
  } catch {
    // A concurrent request won the unique constraint. Re-read to decide
    // whether that request was identical or a conflicting reuse.
    const raced = await db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.organisationId, actor.organisationId),
          eq(idempotencyRecords.idempotencyKey, key),
        ),
      )
      .limit(1);
    const winner = raced[0];
    if (winner && winner.requestHash !== requestHash) throw Errors.idempotencyConflict();
    return { replayOf: winner?.responseReference ?? null };
  }

  return { replayOf: null };
}

/** Records what the command produced, so a later replay can return it. */
export async function recordIdempotentResult(
  db: Database,
  actor: Actor,
  key: string | undefined,
  responseReference: string,
): Promise<void> {
  if (!key) return;
  await db
    .update(idempotencyRecords)
    .set({ responseReference })
    .where(
      and(
        eq(idempotencyRecords.organisationId, actor.organisationId),
        eq(idempotencyRecords.idempotencyKey, key),
      ),
    );
}
