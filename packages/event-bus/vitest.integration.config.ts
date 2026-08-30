import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    // Real broker round-trips, including an exponential backoff retry.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Shared Redis state; parallel files would interfere.
    fileParallelism: false,
  },
});
