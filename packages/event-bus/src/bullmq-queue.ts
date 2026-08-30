/**
 * BullMQ-backed queue. The production scheduling path.
 *
 * Requires a Redis-compatible server with `notify-keyspace-events` including
 * `Ex`, otherwise delayed jobs do not fire reliably, and `maxmemory-policy
 * noeviction`, because BullMQ keeps job state in Redis and eviction silently
 * loses work.
 */
import { Queue, Worker, type JobsOptions } from 'bullmq';
import type { EnqueueOptions, JobEnvelope, JobHandler, JobQueue } from './queue.js';

export interface BullMqConfig {
  readonly connectionUrl: string;
  /** Namespaces keys so parallel test runs and environments cannot collide. */
  readonly prefix?: string;
  readonly defaultAttempts?: number;
}

export class BullMqQueue implements JobQueue {
  readonly #queues = new Map<string, Queue>();
  readonly #workers = new Map<string, Worker>();
  readonly #config: BullMqConfig;

  constructor(config: BullMqConfig) {
    this.#config = config;
  }

  get #connection(): { url: string } {
    return { url: this.#config.connectionUrl };
  }

  #queue(queueName: string): Queue {
    const existing = this.#queues.get(queueName);
    if (existing) return existing;

    const queue = new Queue(queueName, {
      connection: this.#connection,
      prefix: this.#config.prefix ?? 'arf',
    });
    this.#queues.set(queueName, queue);
    return queue;
  }

  register<TPayload>(queueName: string, handler: JobHandler<TPayload>): void {
    if (this.#workers.has(queueName)) {
      throw new Error(`A handler is already registered for queue "${queueName}"`);
    }

    const worker = new Worker(
      queueName,
      async (job) => {
        // job.id is the deterministic key supplied at enqueue time, so the
        // handler sees the same envelope on a retry as on the first attempt.
        await handler({ jobId: String(job.id), payload: job.data as TPayload });
      },
      { connection: this.#connection, prefix: this.#config.prefix ?? 'arf' },
    );

    this.#workers.set(queueName, worker);
  }

  async enqueue<TPayload>(
    queueName: string,
    envelope: JobEnvelope<TPayload>,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const jobOptions: JobsOptions = {
      // BullMQ treats a duplicate jobId as already-queued, which is what makes
      // re-enqueue idempotent (CLAUDE.md 3.6).
      jobId: envelope.jobId,
      attempts: options.attempts ?? this.#config.defaultAttempts ?? 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: false,
    };
    if (options.delayMs !== undefined) jobOptions.delay = options.delayMs;

    const job = await this.#queue(queueName).add(queueName, envelope.payload, jobOptions);
    return String(job.id);
  }

  /** Waits until every registered queue reports no waiting, active or delayed jobs. */
  async drain(): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      let outstanding = 0;
      for (const queue of this.#queues.values()) {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        outstanding += (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
      }
      if (outstanding === 0) return;
      if (Date.now() > deadline) throw new Error('drain timed out with jobs still outstanding');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#workers.values()].map((w) => w.close()));
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
    this.#workers.clear();
    this.#queues.clear();
  }
}
