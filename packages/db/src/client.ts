/**
 * Database client factory.
 *
 * CLAUDE.md 7.1 asks for dependency injection at service boundaries, so this
 * returns a client rather than exporting a module-level singleton. Callers own
 * the lifetime.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as identity from './schema/identity.js';
import * as research from './schema/research.js';
import * as testing from './schema/testing.js';
import * as governance from './schema/governance.js';

export const schema = { ...identity, ...research, ...testing, ...governance };

export interface DbConfig {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

export function createDb(config: DbConfig) {
  const sql = postgres(config.connectionString, {
    max: config.maxConnections ?? 10,
    // CLAUDE.md 7.3: never rely on the server's local timezone.
    types: {},
    onnotice: () => {},
  });

  return { db: drizzle(sql, { schema }), sql };
}

export type Database = ReturnType<typeof createDb>['db'];
