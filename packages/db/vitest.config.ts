import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit run must not require a database; integration has its own config.
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts', '**/node_modules/**'],
  },
});
