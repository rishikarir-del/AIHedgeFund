import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Shared database state; parallel files would interfere.
    fileParallelism: false,
  },
});
