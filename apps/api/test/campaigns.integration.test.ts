/**
 * API auth and ownership, against real PostgreSQL.
 *
 * CLAUDE.md 21.2 names "API auth and ownership" as a required integration
 * test. These drive the real Fastify app through inject, with a real database
 * and no mocked policy layer.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier } from '@arf/auth';
import { createDb, memberships, organisations, users, uuidv7, campaigns, idempotencyRecords, type Database } from '@arf/db';
import { buildApp } from '../src/server.js';

const URL = process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos';

let app: FastifyInstance;
let db: Database;
let close: () => Promise<void>;

const orgA = uuidv7();
const orgB = uuidv7();
const researcherA = uuidv7();
const viewerA = uuidv7();
const researcherB = uuidv7();
const suffix = Date.now();

const token = (subject: string) => ({ authorization: `Bearer dev:${subject}` });

beforeAll(async () => {
  const created = createDb({ connectionString: URL, maxConnections: 4 });
  db = created.db;
  close = () => created.sql.end();

  await db.insert(organisations).values([
    { id: orgA, name: 'Org A', slug: `api-a-${suffix}` },
    { id: orgB, name: 'Org B', slug: `api-b-${suffix}` },
  ]);
  await db.insert(users).values([
    { id: researcherA, externalSubject: `res-a-${suffix}`, email: `ra-${suffix}@test.local` },
    { id: viewerA, externalSubject: `view-a-${suffix}`, email: `va-${suffix}@test.local` },
    { id: researcherB, externalSubject: `res-b-${suffix}`, email: `rb-${suffix}@test.local` },
  ]);
  await db.insert(memberships).values([
    { organisationId: orgA, userId: researcherA, role: 'RESEARCHER' },
    { organisationId: orgA, userId: viewerA, role: 'VIEWER' },
    { organisationId: orgB, userId: researcherB, role: 'RESEARCHER' },
  ]);

  app = await buildApp({ db, verifier: new DevTokenVerifier() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const org of [orgA, orgB]) {
    await db.delete(campaigns).where(eq(campaigns.organisationId, org));
    await db.delete(idempotencyRecords).where(eq(idempotencyRecords.organisationId, org));
    await db.delete(memberships).where(eq(memberships.organisationId, org));
  }
  for (const u of [researcherA, viewerA, researcherB]) {
    await db.delete(users).where(eq(users.id, u));
  }
  for (const org of [orgA, orgB]) {
    await db.delete(organisations).where(eq(organisations.id, org));
  }
  await close();
});

describe('authentication', () => {
  it('serves health without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a missing token with a problem-details body', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/campaigns' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');

    const body = res.json();
    expect(body).toMatchObject({ code: 'unauthenticated', status: 401 });
    // CLAUDE.md 7.5: every field of the problem shape is present.
    for (const field of ['type', 'title', 'status', 'detail', 'instance', 'code', 'traceId']) {
      expect(body[field]).toBeDefined();
    }
  });

  it('rejects a token with no membership', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/campaigns', headers: token('nobody') });
    expect(res.statusCode).toBe(401);
  });
});

describe('authorisation', () => {
  it('refuses a viewer creating a campaign', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: token(`view-a-${suffix}`),
      payload: { name: 'Nope', brief: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'missing_capability' });
  });

  it('allows a researcher creating a campaign', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: token(`res-a-${suffix}`),
      payload: { name: 'Campaign One', brief: 'Trend following on BTC.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Campaign One', organisationId: orgA });
  });

  it('rejects an invalid body with field-level errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: token(`res-a-${suffix}`),
      payload: { name: '', brief: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors?.[0]?.path).toBe('name');
  });
});

describe('organisation ownership (CLAUDE.md 19)', () => {
  it('does not list another organisation campaigns', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: token(`res-b-${suffix}`),
      payload: { name: 'Org B secret', brief: 'b' },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/campaigns', headers: token(`res-a-${suffix}`) });
    const names = res.json().items.map((c: { name: string }) => c.name);
    expect(names).not.toContain('Org B secret');
  });

  it('reports another organisation resource as 404, not 403', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: token(`res-b-${suffix}`),
      payload: { name: 'B only', brief: 'b' },
    });
    const id = created.json().id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/campaigns/${id}`,
      headers: token(`res-a-${suffix}`),
    });
    // 404 rather than 403: a 403 would confirm the resource exists.
    expect(res.statusCode).toBe(404);
  });
});

describe('idempotency (CLAUDE.md 17.5)', () => {
  it('returns the original resource when the same key and body repeat', async () => {
    const headers = { ...token(`res-a-${suffix}`), 'idempotency-key': `key-${suffix}-a` };
    const payload = { name: 'Idempotent', brief: 'once' };

    const first = await app.inject({ method: 'POST', url: '/v1/campaigns', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/v1/campaigns', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it('conflicts when the same key is reused with a different body', async () => {
    const headers = { ...token(`res-a-${suffix}`), 'idempotency-key': `key-${suffix}-b` };

    await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers,
      payload: { name: 'First', brief: 'x' },
    });
    const conflicting = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers,
      payload: { name: 'Different', brief: 'y' },
    });

    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ code: 'idempotency_key_reused' });
  });
});

describe('pagination (CLAUDE.md 17.2)', () => {
  it('caps the page size and returns a cursor', async () => {
    const headers = token(`res-a-${suffix}`);
    for (let i = 0; i < 4; i += 1) {
      await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        headers,
        payload: { name: `Page ${i}`, brief: 'x' },
      });
    }

    const first = await app.inject({ method: 'GET', url: '/v1/campaigns?limit=2', headers });
    const body = first.json();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();

    const next = await app.inject({
      method: 'GET',
      url: `/v1/campaigns?limit=2&after=${body.nextCursor}`,
      headers,
    });
    const ids = next.json().items.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(body.items[0].id);
  });
});
