/**
 * API process entry point.
 *
 * Wires concrete dependencies to the app factory and owns the process
 * lifecycle. Nothing in src/ other than this file reads process.env or binds a
 * port, which is what keeps `buildApp` testable (CLAUDE.md 7.1).
 */
import { ClerkTokenVerifier, DevTokenVerifier, type TokenVerifier } from '@arf/auth';
import { ObjectStore, createDb } from '@arf/db';
import { BullMqInspector, BullMqQueue } from '@arf/event-bus';
import { buildApp } from './server.js';
import { describeConfig, loadConfig, objectStoreConfigured } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const { db, sql } = createDb({ connectionString: config.DATABASE_URL });

  const verifier: TokenVerifier = config.AUTH_DEV_MODE
    ? new DevTokenVerifier()
    : new ClerkTokenVerifier({
        secretKey: config.CLERK_SECRET_KEY as string,
        // The real Clerk SDK is injected here rather than imported into the
        // adapter, keeping @arf/auth free of a provider dependency.
        verifyToken: async (token, secretKey) => {
          const { verifyToken } = await import('@clerk/backend');
          const claims = await verifyToken(token, { secretKey });
          return claims?.sub ? { sub: claims.sub } : null;
        },
      });

  const objectStore = objectStoreConfigured(config)
    ? new ObjectStore({
        endpoint: config.S3_ENDPOINT as string,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET as string,
        accessKeyId: config.S3_ACCESS_KEY_ID as string,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY as string,
        forcePathStyle: true,
      })
    : undefined;

  // Absent when no broker is configured. The dashboard then reports queue
  // depth as null rather than zero: unseen is not the same as empty.
  const redisUrl = process.env['REDIS_URL'];
  const queueInspector = redisUrl
    ? new BullMqInspector({ connectionUrl: redisUrl, prefix: 'arf' })
    : undefined;

  // The API only ever enqueues; workers consume. It registers no handlers,
  // which is what keeps section 3.2 true: workers do not own lifecycle state
  // and the API does not execute jobs.
  const queue = redisUrl ? new BullMqQueue({ connectionUrl: redisUrl, prefix: 'arf' }) : undefined;

  const app = await buildApp({ db, verifier, objectStore, queueInspector, queue, logger: true });

  app.log.info(describeConfig(config), 'starting api');
  if (config.AUTH_DEV_MODE) {
    app.log.warn('AUTH_DEV_MODE is enabled: bearer tokens of the form "dev:<subject>" are accepted');
  }
  if (!queueInspector) {
    app.log.warn('REDIS_URL is not set; the dashboard will report queue depth as unavailable');
  }
  if (!objectStore) {
    app.log.warn('object storage is not configured; verification upload routes are disabled');
  }

  // Drain in-flight requests before releasing the pool, so a shutdown does not
  // abort a transaction mid-write.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      objectStore?.destroy();
      await queueInspector?.close();
      await queue?.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if config validation failed.
  console.error(`api failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
