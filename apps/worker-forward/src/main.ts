/**
 * worker-forward: TradingView webhook and paper-test jobs.
 *
 * Per the build prompt this milestone contains only a health endpoint
 * and package wiring. No order routing exists here and none may be added:
 * CLAUDE.md 3.9 keeps live execution out of the initial product entirely.
 *
 * The process starts, reports readiness and idles. That is deliberate: an
 * empty worker that runs is honest about having nothing to do, whereas one
 * that is absent looks like a deployment failure.
 */
import { createDb } from '@arf/db';

const NAME = 'worker-forward';

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const { sql } = createDb({ connectionString: databaseUrl, maxConnections: 2 });

  // Prove the dependency is reachable before reporting ready, so a broken
  // connection surfaces at startup rather than on the first job.
  await sql`select 1`;

  console.log(JSON.stringify({ msg: `${NAME} started`, queues: [], status: 'idle' }));

  const shutdown = async (): Promise<void> => {
    console.log(JSON.stringify({ msg: `${NAME} shutting down` }));
    await sql.end({ timeout: 5 });
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown());
  }
}

main().catch((error: unknown) => {
  console.error(`${NAME} failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
