import { defineConfig } from '@playwright/test';

const API_PORT = 3101;
const WEB_PORT = 3100;

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://arfos:arfos@localhost:5432/arfos';

/**
 * End-to-end configuration.
 *
 * Both servers are started by Playwright rather than assumed to be running, so
 * a green run means the built artefacts actually boot -- not that someone had
 * a dev server open. Dedicated ports avoid colliding with a running dev stack.
 *
 * AUTH_DEV_MODE is on because these tests need a deterministic identity. The
 * API refuses that flag when NODE_ENV is production, so it cannot leak.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../apps/api',
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL,
        AUTH_DEV_MODE: 'true',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
        S3_BUCKET: process.env['S3_BUCKET'] ?? 'arfos-artefacts',
        S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? 'arfos',
        S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? 'arfos-local-dev',
      },
    },
    {
      command: `node node_modules/next/dist/bin/next start --port ${WEB_PORT}`,
      cwd: '../apps/web',
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ARF_API_URL: `http://127.0.0.1:${API_PORT}`,
        ARF_API_PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
        // The dev-mode subject seeded by packages/db db:seed.
        ARF_API_TOKEN: 'dev:dev-developer',
        NODE_ENV: 'production',
      },
    },
  ],
});
