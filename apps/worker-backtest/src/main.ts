/**
 * Backtest worker process.
 *
 * Registers the ingestion handlers on the queue and runs the outbox relay on
 * an interval. CLAUDE.md 3.2 keeps lifecycle transitions out of here: the
 * worker writes evidence and emits events, and the API decides what that
 * evidence permits.
 */
import { BullMqQueue, type JobQueue } from '@arf/event-bus';
import { ObjectStore, createDb, type Database } from '@arf/db';
import { parseReport, type ParseReportPayload } from './handlers/parse-report.js';
import { computeEvidence, type ComputeEvidencePayload } from './handlers/compute-evidence.js';
import { relayOutbox } from './outbox.js';

export const QUEUES = {
  parseReport: 'report-parse',
  computeEvidence: 'evidence-compute',
} as const;

/** Exported so integration tests can register handlers on an InlineQueue. */
export function registerHandlers(queue: JobQueue, db: Database, store: ObjectStore): void {
  queue.register<ParseReportPayload>(QUEUES.parseReport, async ({ payload }) => {
    const result = await parseReport(db, store, payload);
    // Ingestion and analysis are separate jobs so a parse failure does not
    // retry the arithmetic, and a metrics change can be re-run alone.
    if (result.runId) {
      await queue.enqueue(QUEUES.computeEvidence, {
        jobId: `evidence-${result.runId}`,
        payload: { runId: result.runId } satisfies ComputeEvidencePayload,
      });
    }
  });

  queue.register<ComputeEvidencePayload>(QUEUES.computeEvidence, async ({ payload }) => {
    await computeEvidence(db, payload);
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const { db, sql } = createDb({ connectionString: databaseUrl });
  const store = new ObjectStore({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
    region: process.env['S3_REGION'] ?? 'us-east-1',
    bucket: process.env['S3_BUCKET'] ?? 'arfos-artefacts',
    accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
    forcePathStyle: true,
  });

  const queue = new BullMqQueue({ connectionUrl: redisUrl, prefix: 'arf' });
  registerHandlers(queue, db, store);

  const relay = setInterval(() => {
    void relayOutbox(db, queue).catch((error: unknown) => {
      console.error(`outbox relay failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 2000);

  console.log(JSON.stringify({ msg: 'worker-backtest started', queues: Object.values(QUEUES) }));

  const shutdown = async (): Promise<void> => {
    clearInterval(relay);
    await queue.close();
    store.destroy();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown());
  }
}

// Only run when executed directly, so tests can import registerHandlers.
if (process.argv[1]?.endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(`worker-backtest failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
