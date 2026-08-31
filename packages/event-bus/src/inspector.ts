/**
 * Queue introspection.
 *
 * Reporting queue depth is a read concern, not a scheduling one, so it is a
 * separate interface rather than another method on `JobQueue`. Adding it there
 * would force `InlineQueue` -- which has no broker and no persistent state --
 * to invent an answer.
 *
 * CLAUDE.md 20 lists queue depth as something to instrument, and the Command
 * Centre needs it for its jobs panel.
 */
import { Queue } from 'bullmq';

export interface QueueDepth {
  readonly name: string;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly completed: number;
}

export interface QueueInspector {
  depths(queueNames: readonly string[]): Promise<readonly QueueDepth[]>;
  close(): Promise<void>;
}

export interface BullMqInspectorConfig {
  readonly connectionUrl: string;
  readonly prefix?: string;
}

export class BullMqInspector implements QueueInspector {
  readonly #queues = new Map<string, Queue>();
  readonly #config: BullMqInspectorConfig;

  constructor(config: BullMqInspectorConfig) {
    this.#config = config;
  }

  async depths(queueNames: readonly string[]): Promise<readonly QueueDepth[]> {
    const results: QueueDepth[] = [];

    for (const name of queueNames) {
      let queue = this.#queues.get(name);
      if (!queue) {
        queue = new Queue(name, {
          connection: { url: this.#config.connectionUrl },
          prefix: this.#config.prefix ?? 'arf',
        });
        this.#queues.set(name, queue);
      }

      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
      results.push({
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      });
    }

    return results;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
    this.#queues.clear();
  }
}

/**
 * Used when no broker is configured. Returns nothing rather than zeros: a
 * depth of zero means "the queue is empty", which is a different claim from
 * "we cannot see the queue", and the dashboard must not conflate them.
 */
export class UnavailableQueueInspector implements QueueInspector {
  async depths(): Promise<readonly QueueDepth[]> {
    return [];
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}
