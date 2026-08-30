import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, objectStoreConfigured } from '../src/config.js';

const BASE = {
  DATABASE_URL: 'postgres://arfos:arfos@localhost:5432/arfos',
  AUTH_DEV_MODE: 'true',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(BASE as NodeJS.ProcessEnv);
    expect(config.PORT).toBe(3001);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.NODE_ENV).toBe('development');
  });

  it('fails fast when the database url is missing', () => {
    expect(() => loadConfig({ AUTH_DEV_MODE: 'true' } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('requires an auth mode to be chosen', () => {
    expect(() => loadConfig({ DATABASE_URL: BASE.DATABASE_URL } as NodeJS.ProcessEnv)).toThrow(
      /CLERK_SECRET_KEY/,
    );
  });

  it('refuses dev auth in production', () => {
    expect(() =>
      loadConfig({ ...BASE, NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/must not be enabled in production/);
  });

  it('requires a Clerk key in production', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: BASE.DATABASE_URL,
        NODE_ENV: 'production',
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/CLERK_SECRET_KEY/);
  });
});

describe('objectStoreConfigured', () => {
  it('is false unless every S3 setting is present', () => {
    const partial = loadConfig({ ...BASE, S3_ENDPOINT: 'http://localhost:9000' } as NodeJS.ProcessEnv);
    expect(objectStoreConfigured(partial)).toBe(false);
  });

  it('is true when all four are present', () => {
    const full = loadConfig({
      ...BASE,
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'arfos-artefacts',
      S3_ACCESS_KEY_ID: 'arfos',
      S3_SECRET_ACCESS_KEY: 'secret',
    } as NodeJS.ProcessEnv);
    expect(objectStoreConfigured(full)).toBe(true);
  });
});

describe('describeConfig (CLAUDE.md 19: never log secrets)', () => {
  it('reports presence but never a secret value', () => {
    const config = loadConfig({
      ...BASE,
      S3_SECRET_ACCESS_KEY: 'super-secret-value',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'a',
    } as NodeJS.ProcessEnv);

    const serialised = JSON.stringify(describeConfig(config));
    expect(serialised).not.toContain('super-secret-value');
    expect(serialised).not.toContain(BASE.DATABASE_URL);
    expect(describeConfig(config).objectStoreConfigured).toBe(true);
  });
});
