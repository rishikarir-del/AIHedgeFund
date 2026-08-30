/**
 * Transactional outbox relay.
 *
 * CLAUDE.md 9.3 requires a domain event to be written in the same transaction
 * as the change it describes, then published separately. This is the second
 * half: it drains unpublished rows onto the queue and marks them published.
 *
 * Delivery is at-least-once by design. A crash between enqueue and the
 * published_at update replays the event, which is why the outbox row id is
 * used as the job id: a replayed relay cannot double-deliver (3.6).
 */
import { and, asc, inArray, isNull } from 'drizzle-orm';
import { outboxEvents, type Database } from '@arf/db';
import type { JobQueue } from '@arf/event-bus';

export const OUTBOX_QUEUE = 'domain-events';

export interface RelayResult {
  readonly published: number;
}

export async function relayOutbox(
  db: Database,
  queue: JobQueue,
  batchSize = 100,
): Promise<RelayResult> {
  const pending = await db
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(batchSize);

  if (pending.length === 0) return { published: 0 };

  const delivered: string[] = [];

  for (const event of pending) {
    // The outbox row id is the job id. A replay after a crash enqueues the
    // same id, which the queue treats as already present.
    await queue.enqueue(OUTBOX_QUEUE, {
      jobId: event.id,
      payload: { eventType: event.eventType, ...(event.payload as Record<string, unknown>) },
    });
    delivered.push(event.id);
  }

  // Marked published only after every enqueue succeeded. A failure part-way
  // leaves the whole batch unpublished and it is retried, which is safe
  // precisely because delivery is idempotent.
  await db
    .update(outboxEvents)
    .set({ publishedAt: new Date() })
    .where(and(inArray(outboxEvents.id, delivered), isNull(outboxEvents.publishedAt)));

  return { published: delivered.length };
}
