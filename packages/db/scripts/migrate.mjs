/**
 * Apply pending migrations.
 *
 * CLAUDE.md 9.2 requires every schema change to go through a migration and
 * forbids editing an applied one, so this only ever moves forward.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos';

// max: 1 because migrations must run sequentially on a single connection.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  await migrate(drizzle(sql), { migrationsFolder: new URL('../migrations', import.meta.url).pathname.replace(/^\//, '') });
  console.log('migrations applied');
} catch (err) {
  console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
