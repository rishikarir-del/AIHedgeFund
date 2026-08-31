/**
 * Fastify application factory.
 *
 * Returns an app rather than starting a server, so integration tests can drive
 * it through `inject` without binding a port (CLAUDE.md 7.1: dependency
 * injection at service boundaries).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { TokenVerifier } from '@arf/auth';
import type { JobQueue, QueueInspector } from '@arf/event-bus';
import { deriveObjectKey, validateUpload, type Database, type ObjectStore } from '@arf/db';
import { toProblemDetails } from './errors.js';
import { auth } from './plugins/auth.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerStrategyRoutes } from './routes/strategies.js';
import { registerVerificationRoutes } from './routes/verification.js';
import { registerEvidenceRoutes } from './routes/evidence.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerDashboardRoutes, registerMarketRoutes } from './routes/dashboard.js';
import { registerWalkForwardRoutes } from './routes/walk-forward.js';

export interface BuildAppOptions {
  readonly db: Database;
  readonly verifier: TokenVerifier;
  /** Optional so tests that never touch storage need not stand up MinIO. */
  readonly objectStore?: ObjectStore | undefined;
  /** Optional so tests and offline runs need no broker. */
  readonly queueInspector?: QueueInspector | undefined;
  /** Optional: without it, walk-forward requests are refused rather than dropped. */
  readonly queue?: JobQueue | undefined;
  readonly logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Every request carries a trace id, which appears in problem responses and
    // in audit records (CLAUDE.md 20).
    genReqId: () => randomUUID(),
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

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .type('application/problem+json')
      .send({
        type: 'https://arf-os.local/problems/not_found',
        title: 'Not Found',
        status: 404,
        detail: 'No route matches this path.',
        instance: request.url,
        code: 'not_found',
        traceId: request.id,
      }),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  registerCampaignRoutes(app, options.db);
  registerStrategyRoutes(app, options.db, options.objectStore);
  registerEvidenceRoutes(app, options.db);
  registerDecisionRoutes(app, options.db);
  registerDashboardRoutes(app, options.db, options.queueInspector);
  registerWalkForwardRoutes(app, options.db, options.queue);
  registerMarketRoutes(app, options.db);

  if (options.objectStore) {
    registerVerificationRoutes(
      app,
      options.db,
      options.objectStore,
      validateUpload,
      deriveObjectKey,
    );
  }

  return app;
}
