/**
 * Command Centre read model, against real PostgreSQL.
 *
 * The assertions that matter are about honesty rather than shape: the funnel
 * lists every state including the empty ones, counts are organisation-scoped,
 * and queue depth is null when there is no broker rather than a row of zeros.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier } from '@arf/auth';
import type { QueueInspector } from '@arf/event-bus';
import {
  campaigns,
  createDb,
  memberships,
  organisations,
  strategies,
  strategyVersions,
  users,
  uuidv7,
  type Database,
} from '@arf/db';
import { buildApp } from '../src/server.js';

const URL = process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos';

let app: FastifyInstance;
let appWithQueue: FastifyInstance;
let db: Database;
let close: () => Promise<void>;

const orgA = uuidv7();
const orgB = uuidv7();
const userA = uuidv7();
const userB = uuidv7();
const suffix = Date.now();

const tokenA = { authorization: `Bearer dev:dash-a-${suffix}` };

/** Reports fixed depths so the assertion does not depend on a live broker. */
const fakeInspector: QueueInspector = {
  depths: async (names) =>
    names.map((name) => ({ name, waiting: 2, active: 1, delayed: 0, failed: 0, completed: 7 })),
  close: async () => undefined,
};

beforeAll(async () => {
  const created = createDb({ connectionString: URL, maxConnections: 4 });
  db = created.db;
  close = () => created.sql.end();

  await db.insert(organisations).values([
    { id: orgA, name: 'Dash A', slug: `dash-a-${suffix}` },
    { id: orgB, name: 'Dash B', slug: `dash-b-${suffix}` },
  ]);
  await db.insert(users).values([
    { id: userA, externalSubject: `dash-a-${suffix}`, email: `da-${suffix}@test.local` },
    { id: userB, externalSubject: `dash-b-${suffix}`, email: `db-${suffix}@test.local` },
  ]);
  await db.insert(memberships).values([
    { organisationId: orgA, userId: userA, role: 'RESEARCHER' },
    { organisationId: orgB, userId: userB, role: 'RESEARCHER' },
  ]);

  const [campaignA] = await db
    .insert(campaigns)
    .values({ organisationId: orgA, name: 'A', brief: 'a', createdBy: userA })
    .returning();
  const [strategyA] = await db
    .insert(strategies)
    .values({ organisationId: orgA, campaignId: campaignA!.id, name: 'A1', family: 'trend_following' })
    .returning();
  await db.insert(strategyVersions).values([
    {
      organisationId: orgA,
      strategyId: strategyA!.id,
      versionNumber: 1,
      definitionHash: 'a'.repeat(64),
      state: 'HYPOTHESIS_DRAFT',
    },
    {
      organisationId: orgA,
      strategyId: strategyA!.id,
      versionNumber: 2,
      definitionHash: 'b'.repeat(64),
      state: 'PINE_DEVELOPMENT',
    },
  ]);

  // Another organisation's data, which must never appear in org A's counts.
  const [campaignB] = await db
    .insert(campaigns)
    .values({ organisationId: orgB, name: 'B', brief: 'b', createdBy: userB })
    .returning();
  await db
    .insert(strategies)
    .values({ organisationId: orgB, campaignId: campaignB!.id, name: 'B1', family: 'momentum' });

  app = await buildApp({ db, verifier: new DevTokenVerifier() });
  appWithQueue = await buildApp({
    db,
    verifier: new DevTokenVerifier(),
    queueInspector: fakeInspector,
  });
  await Promise.all([app.ready(), appWithQueue.ready()]);
});

afterAll(async () => {
  await Promise.all([app.close(), appWithQueue.close()]);
  for (const org of [orgA, orgB]) {
    await db.delete(strategyVersions).where(eq(strategyVersions.organisationId, org));
    await db.delete(strategies).where(eq(strategies.organisationId, org));
    await db.delete(campaigns).where(eq(campaigns.organisationId, org));
    await db.delete(memberships).where(eq(memberships.organisationId, org));
  }
  for (const u of [userA, userB]) await db.delete(users).where(eq(users.id, u));
  for (const org of [orgA, orgB]) await db.delete(organisations).where(eq(organisations.id, org));
  await close();
});

describe('GET /v1/dashboard', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('counts only the actor organisation (CLAUDE.md 19)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: tokenA });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.campaigns.total).toBe(1);
    expect(body.strategies.total).toBe(1);
  });

  it('lists every funnel state, including the empty ones', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: tokenA });
    const funnel = res.json().funnel as { state: string; count: number }[];

    // Nine states, always. A funnel that omits empty stages hides where work
    // is not happening, which is the thing a reviewer most needs to see.
    expect(funnel).toHaveLength(9);
    expect(funnel.find((f) => f.state === 'HYPOTHESIS_DRAFT')?.count).toBe(1);
    expect(funnel.find((f) => f.state === 'PINE_DEVELOPMENT')?.count).toBe(1);
    expect(funnel.find((f) => f.state === 'PAPER_APPROVED')?.count).toBe(0);
  });

  it('reports queue depth as null when no broker is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboard', headers: tokenA });
    // Not an empty array: "cannot see the queues" differs from "queues empty".
    expect(res.json().queues).toBeNull();
  });

  it('reports real depths when an inspector is supplied', async () => {
    const res = await appWithQueue.inject({ method: 'GET', url: '/v1/dashboard', headers: tokenA });
    const queues = res.json().queues as { name: string; waiting: number }[];

    expect(queues).toHaveLength(3);
    expect(queues[0]?.waiting).toBe(2);
    expect(queues.map((q) => q.name)).toContain('report-parse');
  });

  it('returns empty decision and failure lists rather than omitting them', async () => {
    const body = (await app.inject({ method: 'GET', url: '/v1/dashboard', headers: tokenA })).json();
    expect(body.decisions.recent).toEqual([]);
    expect(body.parseFailures.recent).toEqual([]);
    expect(body.verifications.pending).toBe(0);
    expect(body.generatedAt).toBeTruthy();
  });
});
