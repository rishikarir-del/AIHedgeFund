/**
 * End-to-end ingestion, against real PostgreSQL and real MinIO.
 *
 * This is the path that turns an uploaded export into evidence: parse the
 * ledger, reconstruct equity from it, compute metrics independently, and
 * compare the result with what the source reported.
 *
 * CLAUDE.md 21.2 names object ingestion as a required integration test, and
 * 3.6 requires the jobs to be idempotent, which is asserted by running the
 * whole pipeline twice and checking nothing duplicates.
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ObjectStore,
  artefacts,
  backtestRuns,
  campaigns,
  createDb,
  deriveObjectKey,
  equityPoints,
  memberships,
  metricSnapshots,
  organisations,
  outboxEvents,
  parityReports,
  reportUploads,
  sha256,
  strategies,
  strategyVersions,
  trades,
  tradingviewVerifications,
  users,
  uuidv7,
  type Database,
} from '@arf/db';
import { InlineQueue } from '@arf/event-bus';
import { computeEvidence } from '../src/handlers/compute-evidence.js';
import { parseReport } from '../src/handlers/parse-report.js';
import { relayOutbox, OUTBOX_QUEUE } from '../src/outbox.js';

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://arfos:arfos@localhost:5432/arfos';
const S3 = {
  endpoint: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: process.env['S3_BUCKET'] ?? 'arfos-artefacts',
  accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'arfos',
  secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? 'arfos-local-dev',
  forcePathStyle: true,
};

/**
 * A TradingView List of Trades export: entry and exit rows in pairs. Three
 * closed trades netting +433.62 - 124.75 + 210.00 = 518.87.
 */
const CSV = [
  'Trade #,Type,Signal,Date/Time,Price USDT,Contracts,Profit USDT',
  '1,Entry long,Long,2024-01-03 15:00,42150.5,0.237,—',
  '1,Exit long,Close,2024-01-05 09:00,43980.1,0.237,433.62',
  '2,Entry short,Short,2024-01-05 09:00,43980.1,0.235,—',
  '2,Exit short,Close,2024-01-08 21:00,44510.9,0.235,(124.75)',
  '3,Entry long,Long,2024-01-10 12:00,44000.0,0.230,—',
  '3,Exit long,Close,2024-01-14 06:00,44913.0,0.230,210.00',
].join('\n');

let db: Database;
let store: ObjectStore;
let close: () => Promise<void>;

const org = uuidv7();
const user = uuidv7();
const suffix = Date.now();
let versionId = '';
let uploadId = '';
let runId = '';

beforeAll(async () => {
  const created = createDb({ connectionString: DB_URL, maxConnections: 4 });
  db = created.db;
  close = () => created.sql.end();

  const admin = new S3Client({
    region: S3.region,
    endpoint: S3.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey },
  });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: S3.bucket }));
  } catch {
    /* already exists */
  }
  admin.destroy();
  store = new ObjectStore(S3);

  await db.insert(organisations).values({ id: org, name: 'Pipeline', slug: `pipe-${suffix}` });
  await db.insert(users).values({
    id: user,
    externalSubject: `pipe-${suffix}`,
    email: `p-${suffix}@test.local`,
  });
  await db.insert(memberships).values({ organisationId: org, userId: user, role: 'DEVELOPER' });

  const [campaign] = await db
    .insert(campaigns)
    .values({ organisationId: org, name: 'Pipeline', brief: 'x', createdBy: user })
    .returning();
  const [strategy] = await db
    .insert(strategies)
    .values({
      organisationId: org,
      campaignId: campaign!.id,
      name: 'Pipeline strategy',
      family: 'trend_following',
    })
    .returning();
  const sourceHash = sha256('//@version=6\nstrategy("Pipeline")');
  const [version] = await db
    .insert(strategyVersions)
    .values({
      organisationId: org,
      strategyId: strategy!.id,
      versionNumber: 1,
      definitionHash: sha256('definition'),
    })
    .returning();
  versionId = version!.id;

  const [verification] = await db
    .insert(tradingviewVerifications)
    .values({
      organisationId: org,
      strategyVersionId: versionId,
      requiredSymbol: 'BYBIT:BTCUSDT.P',
      requiredTimeframe: '60',
      requiredSourceHash: sourceHash,
      status: 'AWAITING_UPLOAD',
    })
    .returning();

  // Store the raw export exactly as an upload would have.
  const body = Buffer.from(CSV, 'utf8');
  const checksum = sha256(body);
  const objectKey = deriveObjectKey(org, 'tradingview_export', checksum);
  await store.putObject(objectKey, body, 'text/csv');

  const [artefact] = await db
    .insert(artefacts)
    .values({
      organisationId: org,
      kind: 'tradingview_export',
      objectKey,
      checksum,
      sizeBytes: body.length,
      contentType: 'text/csv',
    })
    .returning();

  const [upload] = await db
    .insert(reportUploads)
    .values({
      verificationId: verification!.id,
      artefactId: artefact!.id,
      reportType: 'list_of_trades',
    })
    .returning();
  uploadId = upload!.id;
});

afterAll(async () => {
  if (runId) {
    await db.delete(parityReports).where(eq(parityReports.runId, runId));
    await db.delete(metricSnapshots).where(eq(metricSnapshots.runId, runId));
    await db.delete(equityPoints).where(eq(equityPoints.runId, runId));
    await db.delete(trades).where(eq(trades.runId, runId));
    await db.delete(backtestRuns).where(eq(backtestRuns.id, runId));
  }
  await db.delete(reportUploads).where(eq(reportUploads.id, uploadId));
  await db.delete(tradingviewVerifications).where(eq(tradingviewVerifications.organisationId, org));
  await db.delete(artefacts).where(eq(artefacts.organisationId, org));
  await db.delete(strategyVersions).where(eq(strategyVersions.organisationId, org));
  await db.delete(strategies).where(eq(strategies.organisationId, org));
  await db.delete(campaigns).where(eq(campaigns.organisationId, org));
  await db.delete(memberships).where(eq(memberships.organisationId, org));
  await db.delete(users).where(eq(users.id, user));
  await db.delete(organisations).where(eq(organisations.id, org));
  store.destroy();
  await close();
});

describe('ingestion pipeline', () => {
  it('parses the export into a normalised trade ledger', async () => {
    const result = await parseReport(db, store, { uploadId, organisationId: org });

    expect(result.skipped).toBeNull();
    expect(result.runId).toBeTruthy();
    // Six rows in, three closed trades out: entries and exits are paired.
    expect(result.tradesWritten).toBe(3);
    runId = result.runId as string;
  });

  it('pairs entries with exits and reads a parenthesised loss as negative', async () => {
    const ledger = await db.select().from(trades).where(eq(trades.runId, runId));
    const profits = ledger.map((t) => Number(t.profit)).sort((a, b) => a - b);
    expect(profits).toEqual([-124.75, 210, 433.62]);
  });

  it('computes equity, metrics and parity independently of the report', async () => {
    const result = await computeEvidence(db, { runId });

    expect(result.closedTrades).toBe(3);
    expect(result.equityPoints).toBe(3);

    const [snapshot] = await db
      .select()
      .from(metricSnapshots)
      .where(eq(metricSnapshots.runId, runId));
    const metrics = snapshot!.metrics as Record<string, unknown>;

    // 433.62 + 210.00 - 124.75 = 518.87, derived from the ledger, not read.
    expect(Number(metrics['netProfit'])).toBeCloseTo(518.87, 2);
    expect(metrics['closedTradeCount']).toBe(3);
    // Regression guard: a rising curve must never report zero runup.
    expect(Number(metrics['maxRunup'])).toBeGreaterThan(0);
  });

  it('records a parity verdict rather than silently agreeing', async () => {
    const [parity] = await db.select().from(parityReports).where(eq(parityReports.runId, runId));
    expect(parity).toBeDefined();
    // The export carried no reported totals, so parity cannot be evaluated --
    // and says so instead of returning PASS.
    expect(parity!.verdict).toBe('INSUFFICIENT_DATA');
  });

  it('is idempotent: re-running writes nothing new (CLAUDE.md 3.6)', async () => {
    const before = {
      trades: (await db.select().from(trades).where(eq(trades.runId, runId))).length,
      equity: (await db.select().from(equityPoints).where(eq(equityPoints.runId, runId))).length,
      snapshots: (await db.select().from(metricSnapshots).where(eq(metricSnapshots.runId, runId)))
        .length,
      runs: (await db.select().from(backtestRuns).where(eq(backtestRuns.id, runId))).length,
    };

    await parseReport(db, store, { uploadId, organisationId: org });
    await computeEvidence(db, { runId });

    expect((await db.select().from(trades).where(eq(trades.runId, runId))).length).toBe(before.trades);
    expect((await db.select().from(equityPoints).where(eq(equityPoints.runId, runId))).length).toBe(
      before.equity,
    );
    expect(
      (await db.select().from(metricSnapshots).where(eq(metricSnapshots.runId, runId))).length,
    ).toBe(before.snapshots);
    expect((await db.select().from(backtestRuns).where(eq(backtestRuns.id, runId))).length).toBe(
      before.runs,
    );
  });

  it('relays outbox events onto the queue exactly once', async () => {
    const queue = new InlineQueue();
    const delivered: string[] = [];
    queue.register<{ eventType: string }>(OUTBOX_QUEUE, async ({ payload }) => {
      delivered.push(payload.eventType);
    });

    const first = await relayOutbox(db, queue);
    await queue.drain();
    expect(first.published).toBeGreaterThan(0);
    expect(delivered).toContain('backtest_run.ingested');

    // Nothing remains unpublished, so a second pass is a no-op.
    const second = await relayOutbox(db, queue);
    expect(second.published).toBe(0);

    await db.delete(outboxEvents).where(eq(outboxEvents.eventType, 'backtest_run.ingested'));
    await db.delete(outboxEvents).where(eq(outboxEvents.eventType, 'backtest_run.evidence_computed'));
    await queue.close();
  });
});
