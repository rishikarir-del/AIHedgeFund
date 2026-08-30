/**
 * Job queue abstraction.
 *
 * The handlers that do real work -- report parsing, metric calculation, equity
 * reconstruction, parity -- are pure functions per CLAUDE.md 14. This interface
 * is only the scheduling and retry layer around them, injected at the service
 * boundary as 7.1 requires.
 *
 * Two implementations satisfy it. `InlineQueue` runs a handler immediately in
 * process and is used in unit tests and where a broker is unavailable.
 * `BullMqQueue` is the production path. Because handlers never see which one
 * they are running under, swapping between them changes no business logic.
 *
 * CLAUDE.md 3.6 requires jobs to be idempotent: `jobId` is therefore part of
 * the enqueue contract rather than an option, so a retry cannot silently
 * duplicate work.
 */

export interface JobEnvelope<TPayload> {
  /** Deterministic key. Re-enqueuing the same id must not run the job twice. */
  readonly jobId: string;
  readonly payload: TPayload;
}

export type JobHandler<TPayload> = (envelope: JobEnvelope<TPayload>) => Promise<void>;

export interface EnqueueOptions {
  readonly delayMs?: number;
  readonly attempts?: number;
}

export interface JobQueue {
  /** Returns the job id actually used, which may be an existing one on a duplicate. */
  enqueue<TPayload>(
    queueName: string,
    envelope: JobEnvelope<TPayload>,
    options?: EnqueueOptions,
  ): Promise<string>;

  register<TPayload>(queueName: string, handler: JobHandler<TPayload>): void;

  /** Resolves once every job enqueued so far has settled. */
  drain(): Promise<void>;

  close(): Promise<void>;
}

/**
 * In-process queue. Executes on enqueue, so ordering is deterministic and
 * failures surface synchronously -- which is what unit tests want.
 */
export class InlineQueue implements JobQueue {
  readonly #handlers = new Map<string, JobHandler<never>>();
  readonly #seen = new Set<string>();
  #pending: Promise<void> = Promise.resolve();

  register<TPayload>(queueName: string, handler: JobHandler<TPayload>): void {
    this.#handlers.set(queueName, handler);
  }

  async enqueue<TPayload>(
    queueName: string,
    envelope: JobEnvelope<TPayload>,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const key = `${queueName}:${envelope.jobId}`;
    if (this.#seen.has(key)) return envelope.jobId;
    this.#seen.add(key);

    const handler = this.#handlers.get(queueName);
    if (!handler) {
      throw new Error(`No handler registered for queue "${queueName}"`);
    }

    const run = async (): Promise<void> => {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      await (handler as JobHandler<TPayload>)(envelope);
    };

    this.#pending = this.#pending.then(run);
    return envelope.jobId;
  }

  async drain(): Promise<void> {
    await this.#pending;
  }

  async close(): Promise<void> {
    await this.drain();
    this.#handlers.clear();
  }
}
