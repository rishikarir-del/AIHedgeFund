/**
 * worker-research: model and research jobs.
 *
 * Agent runs land here once packages/agent-runtime exists. Nothing is
 * wired yet, and no queue is registered, because a worker that consumes jobs it
 * cannot process would fail them rather than leave them queued.
 *
 * The process starts, reports readiness and idles. That is deliberate: an
 * empty worker that runs is honest about having nothing to do, whereas one
 * that is absent looks like a deployment failure.
 */
import { createDb } from '@arf/db';

const NAME = 'worker-research';

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
