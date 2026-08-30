/**
 * Development seed.
 *
 * Creates the minimum identity needed to authenticate locally: an
 * organisation, three users with distinct roles, and their memberships. That
 * is all.
 *
 * It deliberately seeds no campaigns, strategies or backtest results. The
 * build prompt forbids fake data outside tests and explicit fixtures, and a
 * library of invented strategies would undermine the one thing this system is
 * for. Run the pipeline against a real export to get evidence.
 *
 * Idempotent: re-running changes nothing (CLAUDE.md 3.6).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { memberships, organisations, users } from '../dist/schema/identity.js';
import { uuidv7 } from '../dist/ids.js';

const url = process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos';
const sql = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(sql);

const ORG_SLUG = 'dev-org';

const SEED_USERS = [
  { subject: 'dev-researcher', email: 'researcher@dev.local', role: 'RESEARCHER' },
  { subject: 'dev-developer', email: 'developer@dev.local', role: 'DEVELOPER' },
  { subject: 'dev-committee', email: 'committee@dev.local', role: 'COMMITTEE_MEMBER' },
];

try {
  const existingOrg = await db
    .select()
    .from(organisations)
    .where(eq(organisations.slug, ORG_SLUG))
    .limit(1);

  const organisationId =
    existingOrg[0]?.id ??
    (
      await db
        .insert(organisations)
        .values({ id: uuidv7(), name: 'Development Organisation', slug: ORG_SLUG })
        .returning()
    )[0].id;

  for (const seed of SEED_USERS) {
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.externalSubject, seed.subject))
      .limit(1);

    const userId =
      existingUser[0]?.id ??
      (
        await db
          .insert(users)
          .values({ id: uuidv7(), externalSubject: seed.subject, email: seed.email })
          .returning()
      )[0].id;

    await db
      .insert(memberships)
      .values({ organisationId, userId, role: seed.role })
      .onConflictDoNothing();

    console.log(`seeded ${seed.role.padEnd(17)} token: dev:${seed.subject}`);
  }

  console.log(`\norganisation ${organisationId}`);
  console.log('No campaigns or strategies seeded: evidence must be earned, not fabricated.');
} catch (err) {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
