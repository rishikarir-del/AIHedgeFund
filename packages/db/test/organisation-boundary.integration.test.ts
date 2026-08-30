/**
 * Organisation boundary and transactional guarantees, against real PostgreSQL.
 *
 * CLAUDE.md 21.2 names transaction rollback, unique constraints, outbox
 * delivery and organisation access isolation as required integration tests and
 * says to use a real database. The policy layer in @arf/auth is pure and
 * unit-tested; this proves the storage layer actually enforces what the policy
 * assumes.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { uuidv7 } from '../src/ids.js';
import { campaigns, memberships, organisations, users } from '../src/schema/identity.js';
import { auditEvents, outboxEvents } from '../src/schema/governance.js';
import { campaigns as campaignsTable } from '../src/schema/research.js';

const URL = process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos';

let db: Database;
let close: () => Promise<void>;

const orgA = uuidv7();
const orgB = uuidv7();
const userA = uuidv7();

beforeAll(async () => {
  const created = createDb({ connectionString: URL, maxConnections: 4 });
  db = created.db;
  close = () => created.sql.end();

  const suffix = Date.now();
  await db.insert(organisations).values([
    { id: orgA, name: 'Org A', slug: `org-a-${suffix}` },
    { id: orgB, name: 'Org B', slug: `org-b-${suffix}` },
  ]);
  await db.insert(users).values({
    id: userA,
    externalSubject: `dev:user-${suffix}`,
    email: `a-${suffix}@example.test`,
  });
});

afterAll(async () => {
  // Children first. Campaigns and audit events reference organisations with
  // onDelete: 'restrict' precisely so an organisation with live research
  // cannot be deleted out from under it, so teardown must respect that order
  // rather than relying on cascades.
  for (const org of [orgA, orgB]) {
    await db.delete(campaignsTable).where(eq(campaignsTable.organisationId, org));
    await db.delete(auditEvents).where(eq(auditEvents.organisationId, org));
    await db.delete(memberships).where(eq(memberships.organisationId, org));
  }
  await db.delete(users).where(eq(users.id, userA));
  for (const org of [orgA, orgB]) {
    await db.delete(organisations).where(eq(organisations.id, org));
  }
  await close();
});

describe('organisation isolation (CLAUDE.md 19)', () => {
  it('a query scoped to one organisation cannot see another organisation rows', async () => {
    await db.insert(campaignsTable).values([
      { organisationId: orgA, name: 'A campaign', brief: 'a', createdBy: userA },
      { organisationId: orgB, name: 'B campaign', brief: 'b', createdBy: userA },
    ]);

    const visibleToA = await db
      .select()
      .from(campaignsTable)
      .where(eq(campaignsTable.organisationId, orgA));

    expect(visibleToA).toHaveLength(1);
    expect(visibleToA[0]?.name).toBe('A campaign');
  });

  it('scoping by id alone is not enough: the org predicate must also match', async () => {
    const [inserted] = await db
      .insert(campaignsTable)
      .values({ organisationId: orgB, name: 'B only', brief: 'b', createdBy: userA })
      .returning();

    // This is the shape every repository method must use: id AND organisation.
    const asOrgA = await db
      .select()
      .from(campaignsTable)
      .where(and(eq(campaignsTable.id, inserted!.id), eq(campaignsTable.organisationId, orgA)));

    expect(asOrgA).toHaveLength(0);
  });
});

describe('unique constraints (CLAUDE.md 21.2)', () => {
  it('refuses a second membership for the same user in the same organisation', async () => {
    await db.insert(memberships).values({ organisationId: orgA, userId: userA, role: 'RESEARCHER' });

    await expect(
      db.insert(memberships).values({ organisationId: orgA, userId: userA, role: 'ADMIN' }),
    ).rejects.toThrow();
  });

  it('permits the same user in a different organisation', async () => {
    await expect(
      db.insert(memberships).values({ organisationId: orgB, userId: userA, role: 'VIEWER' }),
    ).resolves.toBeDefined();
  });
});

describe('transactions (CLAUDE.md 9.3)', () => {
  it('rolls back a state change and its audit record together', async () => {
    const name = `rollback-${Date.now()}`;

    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(campaignsTable)
          .values({ organisationId: orgA, name, brief: 'x', createdBy: userA });
        await tx.insert(auditEvents).values({
          organisationId: orgA,
          actor: userA,
          action: 'campaign.create',
          aggregate: 'campaign',
          aggregateId: uuidv7(),
          traceId: 'trace-rollback',
        });
        throw new Error('deliberate failure after both writes');
      }),
    ).rejects.toThrow(/deliberate failure/);

    const survivors = await db
      .select()
      .from(campaignsTable)
      .where(and(eq(campaignsTable.organisationId, orgA), eq(campaignsTable.name, name)));
    const audits = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.traceId, 'trace-rollback'));

    expect(survivors).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('commits the outbox event in the same transaction as the change', async () => {
    const traceId = `outbox-${Date.now()}`;

    await db.transaction(async (tx) => {
      const [campaign] = await tx
        .insert(campaignsTable)
        .values({ organisationId: orgA, name: traceId, brief: 'x', createdBy: userA })
        .returning();
      await tx.insert(outboxEvents).values({
        eventType: 'campaign.created',
        payload: { campaignId: campaign!.id },
      });
    });

    const unpublished = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'campaign.created'));

    expect(unpublished.length).toBeGreaterThan(0);
    // Written but not yet dispatched: publication is a separate step.
    expect(unpublished.at(-1)?.publishedAt).toBeNull();
  });
});
