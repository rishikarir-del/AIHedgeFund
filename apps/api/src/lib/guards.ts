/**
 * Shared route guards.
 *
 * Every handler repeats the same three steps -- resolve the actor, check a
 * capability, fetch a row scoped to the actor's organisation. Factoring them
 * here keeps handlers thin per CLAUDE.md 17.1 and means the organisation
 * predicate cannot be forgotten in one route while present in the rest.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { authorise, type Actor, type Capability } from '@arf/auth';
import type { Database } from '@arf/db';
import { Errors } from '../errors.js';
import { requireActor } from '../plugins/auth.js';

/** Resolves the actor and checks one capability, or throws the right problem. */
export function guard(request: FastifyRequest, capability: Capability): Actor {
  const actor = requireActor(request);
  const decision = authorise({
    actor,
    capability,
    resourceOrganisationId: actor.organisationId,
  });
  if (!decision.allowed) throw Errors.forbidden(decision.code, decision.reason);
  return actor;
}

export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw Errors.validation(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

/**
 * Fetches exactly one row scoped to the actor's organisation.
 *
 * Absent and belonging-to-another-organisation are deliberately the same
 * outcome: a 404. Distinguishing them would confirm existence across a tenant
 * boundary (CLAUDE.md 19).
 */
export async function fetchScoped<T extends Record<string, unknown>>(
  db: Database,
  table: PgTable,
  predicate: SQL,
  organisationColumn: SQL | undefined,
  actor: Actor,
  resourceName: string,
): Promise<T> {
  const where = organisationColumn ? and(predicate, organisationColumn) : predicate;
  const rows = (await db.select().from(table).where(where).limit(1)) as T[];
  const row = rows[0];
  if (!row) throw Errors.notFound(resourceName);
  return row;
}

export { and, eq };
