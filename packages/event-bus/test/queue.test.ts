import { describe, expect, it } from 'vitest';
import { InlineQueue } from '../src/queue.js';

describe('InlineQueue', () => {
  it('runs a registered handler', async () => {
    const queue = new InlineQueue();
    const seen: string[] = [];
    queue.register<{ value: string }>('parse', async ({ payload }) => {
      seen.push(payload.value);
    });

    await queue.enqueue('parse', { jobId: 'a', payload: { value: 'hello' } });
    await queue.drain();

    expect(seen).toEqual(['hello']);
  });

  it('does not run the same job id twice (CLAUDE.md 3.6)', async () => {
    const queue = new InlineQueue();
    let runs = 0;
    queue.register('metrics', async () => {
      runs += 1;
    });

    await queue.enqueue('metrics', { jobId: 'same', payload: {} });
    await queue.enqueue('metrics', { jobId: 'same', payload: {} });
    await queue.drain();

    expect(runs).toBe(1);
  });

  it('preserves enqueue order', async () => {
    const queue = new InlineQueue();
    const order: number[] = [];
    queue.register<{ n: number }>('ordered', async ({ payload }) => {
      order.push(payload.n);
    });

    for (const n of [1, 2, 3]) {
      await queue.enqueue('ordered', { jobId: `job-${n}`, payload: { n } });
    }
    await queue.drain();

    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects an unregistered queue rather than silently dropping work', async () => {
    const queue = new InlineQueue();
    await expect(queue.enqueue('nobody', { jobId: 'x', payload: {} })).rejects.toThrow(
      /No handler registered/,
    );
  });
});
