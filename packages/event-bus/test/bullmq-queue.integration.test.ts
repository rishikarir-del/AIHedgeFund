/**
 * Integration test against a real Redis-compatible server.
 *
 * CLAUDE.md 21.2 names "BullMQ job retry" as a required integration test and
 * says to use real Redis rather than a fake, so this does not mock anything.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BullMqQueue } from '../src/bullmq-queue.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let queue: BullMqQueue | undefined;

afterEach(async () => {
  await queue?.close();
  queue = undefined;
});

/** Unique per run so repeated runs cannot see each other's jobs. */
function uniqueName(base: string): string {
  return `${base}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe('BullMqQueue', () => {
  it('delivers a job to its handler', async () => {
    queue = new BullMqQueue({ connectionUrl: REDIS_URL, prefix: 'arf-test' });
    const name = uniqueName('deliver');

    const received: string[] = [];
    const done = new Promise<void>((resolve) => {
      queue!.register<{ value: string }>(name, async ({ payload }) => {
        received.push(payload.value);
        resolve();
      });
    });

    await queue.enqueue(name, { jobId: 'job-1', payload: { value: 'processed' } });
    await done;

    expect(received).toEqual(['processed']);
  });

  it('retries a failing job, then succeeds (CLAUDE.md 21.2)', async () => {
    queue = new BullMqQueue({ connectionUrl: REDIS_URL, prefix: 'arf-test' });
    const name = uniqueName('retry');

    let attempts = 0;
    const succeeded = new Promise<void>((resolve) => {
      queue!.register(name, async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`deliberate failure ${attempts}`);
        resolve();
      });
    });

    await queue.enqueue(name, { jobId: 'flaky', payload: {} }, { attempts: 3 });
    await succeeded;

    expect(attempts).toBe(3);
  });

  it('treats a duplicate job id as already queued', async () => {
    queue = new BullMqQueue({ connectionUrl: REDIS_URL, prefix: 'arf-test' });
    const name = uniqueName('idempotent');

    let runs = 0;
    queue.register(name, async () => {
      runs += 1;
    });

    const first = await queue.enqueue(name, { jobId: 'stable-key', payload: {} });
    const second = await queue.enqueue(name, { jobId: 'stable-key', payload: {} });
    await queue.drain();
    // Give the worker a moment past drain to finish the callback.
    await new Promise((r) => setTimeout(r, 250));

    expect(first).toBe('stable-key');
    expect(second).toBe('stable-key');
    expect(runs).toBe(1);
  });

  it('honours a delay, which requires keyspace notifications to be enabled', async () => {
    queue = new BullMqQueue({ connectionUrl: REDIS_URL, prefix: 'arf-test' });
    const name = uniqueName('delayed');

    const startedAt = Date.now();
    let ranAt = 0;
    const done = new Promise<void>((resolve) => {
      queue!.register(name, async () => {
        ranAt = Date.now();
        resolve();
      });
    });

    await queue.enqueue(name, { jobId: 'later', payload: {} }, { delayMs: 600 });
    await done;

    expect(ranAt - startedAt).toBeGreaterThanOrEqual(500);
  });
});
