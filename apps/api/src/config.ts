/**
 * Runtime configuration.
 *
 * Validated at startup rather than read lazily, so a missing variable fails
 * the process immediately instead of surfacing as a confusing error on the
 * first request that happens to need it.
 *
 * CLAUDE.md 19 forbids logging secrets, so nothing here is ever echoed. The
 * summary helper reports presence, never values.
 */
import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  CLERK_SECRET_KEY: z.string().optional(),
  /**
   * Opt-in dev authentication. Refused in production below, because a bypass
   * that can be switched on by an environment variable is only safe if the
   * switch itself cannot be flipped where it matters.
   */
  AUTH_DEV_MODE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }

  const config = parsed.data;

  if (config.NODE_ENV === 'production') {
    if (config.AUTH_DEV_MODE) {
      throw new Error('AUTH_DEV_MODE must not be enabled in production.');
    }
    if (!config.CLERK_SECRET_KEY) {
      throw new Error('CLERK_SECRET_KEY is required in production.');
    }
  }

  if (!config.AUTH_DEV_MODE && !config.CLERK_SECRET_KEY) {
    throw new Error('Set CLERK_SECRET_KEY, or AUTH_DEV_MODE=true for local development.');
  }

  return config;
}

export function objectStoreConfigured(config: Config): boolean {
  return Boolean(
    config.S3_ENDPOINT && config.S3_BUCKET && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY,
  );
}

/** Presence only. Never values -- these are secrets (section 19). */
export function describeConfig(config: Config): Record<string, string | number | boolean> {
  return {
    nodeEnv: config.NODE_ENV,
    host: config.HOST,
    port: config.PORT,
    logLevel: config.LOG_LEVEL,
    databaseConfigured: Boolean(config.DATABASE_URL),
    objectStoreConfigured: objectStoreConfigured(config),
    authMode: config.AUTH_DEV_MODE ? 'dev' : 'clerk',
  };
}
