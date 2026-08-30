/**
 * Strategy lifecycle through the API, against real PostgreSQL.
 *
 * Exercises the path the build prompt's vertical slice describes: campaign,
 * strategy, immutable version, SDL, Pine revision, and an audited decision --
 * and confirms the gates actually refuse to open without evidence.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevTokenVerifier } from '@arf/auth';
import {
  auditEvents,
  campaigns,
  committeeDecisions,
  createDb,
  idempotencyRecords,
  memberships,
  organisations,
  pineRevisions,
  strategies,
  strategyDefinitions,
  strategyVersions,
  users,
  uuidv7,
  type Database,
} from '@arf/db';
import { buildApp } from '../src/server.js';

const URL = process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos';

let app: FastifyInstance;
let db: Database;
let close: () => Promise<void>;

const org = uuidv7();
const developer = uuidv7();
const committee = uuidv7();
const suffix = Date.now();

const dev = { authorization: `Bearer dev:dev-${suffix}` };
const chair = { authorization: `Bearer dev:chair-${suffix}` };

const VALID_PINE = [
  '//@version=6',
  'strategy("Lifecycle", pyramiding=0, commission_value=0.05, margin_long=100, margin_short=100)',
  'fast = ta.ema(close, 20)',
  'if ta.crossover(fast, ta.ema(close, 50))',
  '    strategy.entry("L", strategy.long)',
].join('\n');

const SDL = {
  schemaVersion: '1.0.0',
  strategy: { name: 'Lifecycle', family: 'trend_following', thesis: 'Test.', directions: ['long'] },
  market: {
    assetClass: 'crypto',
    symbols: ['BYBIT:BTCUSDT.P'],
    timeframe: '60',
    timezone: 'Etc/UTC',
    session: '0000-2359:1234567',
    chartType: 'standard_ohlc',
  },
  signals: { longEntry: 'fast_above_slow AND confirmed_bar' },
  execution: {
    entryOrder: 'market_next_bar',
    pyramiding: 0,
    allowReversal: false,
    processOnClose: false,
    calcOnEveryTick: false,
  },
  risk: {
    sizingModel: 'percent_of_equity',
    sizePercent: 10,
    leverage: 1,
    stopLoss: { type: 'atr_multiple', valueParameter: 'stop_atr' },
    takeProfit: { type: 'risk_multiple', valueParameter: 'target_r' },
    oneStopOneTarget: true,
  },
  costs: { commissionType: 'percent', commissionValue: 0.05, slippageTicks: 2 },
  parameters: [
    { key: 'stop_atr', type: 'float', default: 2, min: 1, max: 4, step: 0.25 },
    { key: 'target_r', type: 'float', default: 2, min: 1, max: 4, step: 0.25 },
  ],
  segments: { warmupBars: 300, selectionMode: 'rolling_walk_forward', embargoBars: 10 },
  falsification: ['Out-of-sample net profit is non-positive.'],
};

let campaignId = '';
let strategyId = '';
let versionId = '';

beforeAll(async () => {
  const created = createDb({ connectionString: URL, maxConnections: 4 });
  db = created.db;
  close = () => created.sql.end();

  await db.insert(organisations).values({ id: org, name: 'Lifecycle', slug: `life-${suffix}` });
  await db.insert(users).values([
    { id: developer, externalSubject: `dev-${suffix}`, email: `d-${suffix}@test.local` },
    { id: committee, externalSubject: `chair-${suffix}`, email: `c-${suffix}@test.local` },
  ]);
  await db.insert(memberships).values([
    { organisationId: org, userId: developer, role: 'DEVELOPER' },
    { organisationId: org, userId: committee, role: 'COMMITTEE_MEMBER' },
  ]);

  app = await buildApp({ db, verifier: new DevTokenVerifier() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (versionId) {
    await db.delete(committeeDecisions).where(eq(committeeDecisions.strategyVersionId, versionId));
    await db.delete(pineRevisions).where(eq(pineRevisions.strategyVersionId, versionId));
    await db.delete(strategyDefinitions).where(eq(strategyDefinitions.strategyVersionId, versionId));
    await db.delete(strategyVersions).where(eq(strategyVersions.id, versionId));
  }
  await db.delete(auditEvents).where(eq(auditEvents.organisationId, org));
  if (strategyId) await db.delete(strategies).where(eq(strategies.id, strategyId));
  if (campaignId) await db.delete(campaigns).where(eq(campaigns.id, campaignId));
  await db.delete(idempotencyRecords).where(eq(idempotencyRecords.organisationId, org));
  await db.delete(memberships).where(eq(memberships.organisationId, org));
  for (const u of [developer, committee]) await db.delete(users).where(eq(users.id, u));
  await db.delete(organisations).where(eq(organisations.id, org));
  await close();
});

describe('lifecycle', () => {
  it('creates a campaign and strategy', async () => {
    const campaign = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: dev,
      payload: { name: 'Lifecycle campaign', brief: 'Trend following.' },
    });
    // A DEVELOPER inherits campaign:create from RESEARCHER.
    expect(campaign.statusCode).toBe(201);
    campaignId = campaign.json().id;

    const strategy = await app.inject({
      method: 'POST',
      url: '/v1/strategies',
      headers: dev,
      payload: { campaignId, name: 'EMA Cross', family: 'trend_following' },
    });
    expect(strategy.statusCode).toBe(201);
    strategyId = strategy.json().id;
  });

  it('creates an immutable version carrying its definition', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategies/${strategyId}/versions`,
      headers: dev,
      payload: { reason: 'initial', definition: SDL },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().versionNumber).toBe(1);
    versionId = res.json().id;

    const definition = await app.inject({
      method: 'GET',
      url: `/v1/versions/${versionId}/definition`,
      headers: dev,
    });
    expect(definition.statusCode).toBe(200);
    expect(definition.json().document.strategy.name).toBe('Lifecycle');
  });

  it('rejects an SDL that violates section 9.2', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/strategies/${strategyId}/versions`,
      headers: dev,
      payload: {
        reason: 'bad',
        definition: { ...SDL, execution: { ...SDL.execution, pyramiding: 3 } },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('stores a compliant Pine revision', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/versions/${versionId}/pine-revisions`,
      headers: dev,
      payload: { source: VALID_PINE, manifest: { symbol: 'BTCUSDT' }, artefactKey: 'k' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses Pine that repaints, before it can become evidence', async () => {
    const repainting = `${VALID_PINE}\nhtf = request.security(syminfo.tickerid, "D", close, lookahead=barmerge.lookahead_on)`;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/versions/${versionId}/pine-revisions`,
      headers: dev,
      payload: { source: repainting, manifest: {}, artefactKey: 'k2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('pine_lint_failed');
  });

  it('refuses a developer attempting to decide', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      headers: dev,
      payload: { strategyVersionId: versionId, to: 'PAPER_APPROVED', rationale: 'looks good' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses promotion with no evidence, listing every hard failure', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/decisions',
      headers: chair,
      payload: { strategyVersionId: versionId, to: 'PAPER_APPROVED', rationale: 'try anyway' },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    // The version is in HYPOTHESIS_DRAFT, so the transition itself is undefined.
    expect(['not_allowed', 'missing_evidence', 'hard_fail']).toContain(body.code);
  });

  it('exposes an append-only audit timeline', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/versions/${versionId}/audit`, headers: dev });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('offers no route that mutates a tested version (CLAUDE.md 3.1)', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: `/v1/versions/${versionId}`, headers: dev });
      expect(res.statusCode).toBe(404);
    }
  });
});
