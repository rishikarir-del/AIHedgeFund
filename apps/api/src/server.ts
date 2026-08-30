/**
 * Fastify application factory.
 *
 * Returns an app rather than starting a server, so integration tests can drive
 * it through `inject` without binding a port (CLAUDE.md 7.1: dependency
 * injection at service boundaries).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { TokenVerifier } from '@arf/auth';
import type { Database } from '@arf/db';
import { toProblemDetails } from './errors.js';
import { auth } from './plugins/auth.js';
import { registerCampaignRoutes } from './routes/campaigns.js';

export interface BuildAppOptions {
  readonly db: Database;
  readonly verifier: TokenVerifier;
  readonly logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Every request carries a trace id, which appears in problem responses and
    // in audit records (CLAUDE.md 20).
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(auth, { verifier: options.verifier, db: options.db });

  app.setErrorHandler((error, request, reply) => {
    const problem = toProblemDetails(error, request.url, request.id);

    // Log the real error server-side; the client sees only the problem body.
    if (problem.status >= 500) {
      request.log.error({ err: error, traceId: request.id }, 'unhandled error');
    }

    return reply.code(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = toProblemDetails(
      Object.assign(new Error('Route not found'), { name: 'NotFound' }),
      request.url,
      request.id,
    );
    return reply.code(404).type('application/problem+json').send({ ...problem, status: 404, code: 'not_found' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerCampaignRoutes(app, options.db);

  return app;
}
