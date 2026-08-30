import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit run must not require a database, a broker or object storage.
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts', '**/node_modules/**'],
  },
});
