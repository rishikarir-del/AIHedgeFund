/**
 * Authentication: bearer token to Actor.
 *
 * CLAUDE.md 19 forbids trusting a client-supplied organisation id, so the
 * organisation on the Actor comes from a membership row read here, never from
 * the request. A token proves who you are; the database decides where you
 * belong and with what role.
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Actor, RbacRole, TokenVerifier } from '@arf/auth';
import { memberships, users, type Database } from '@arf/db';
import { Errors } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export interface AuthPluginOptions {
  readonly verifier: TokenVerifier;
  readonly db: Database;
}

async function authPlugin(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  app.decorateRequest('actor', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;

    const verified = await options.verifier.verify(header.slice('Bearer '.length));
    if (!verified) return;

    const rows = await options.db
      .select({ role: memberships.role, organisationId: memberships.organisationId, userId: users.id })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(eq(users.externalSubject, verified.externalSubject))
      .limit(1);

    const row = rows[0];
    if (!row) return;

    request.actor = {
      userId: row.userId,
      organisationId: row.organisationId,
      role: row.role as RbacRole,
      traceId: request.id,
    };
  });
}

export const auth = fp(authPlugin, { name: 'arf-auth' });

/** Throws rather than returning null, so a handler cannot forget to check. */
export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) throw Errors.unauthenticated();
  return request.actor;
}

/**
 * Confirms the actor's organisation owns the row. Used by repositories that
 * already scope their queries, as a second line of defence: 19 says verify
 * ownership on every aggregate access, and a query predicate that gets edited
 * later should not silently widen access.
 */
export function assertOwnership(actor: Actor, resourceOrganisationId: string, resource: string): void {
  if (actor.organisationId !== resourceOrganisationId) {
    throw Errors.notFound(resource);
  }
}

export { and, eq };
