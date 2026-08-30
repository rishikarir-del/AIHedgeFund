/**
 * Ingests a sample TradingView export into the development organisation.
 *
 * This is an explicit development fixture, which the build prompt permits, and
 * it is clearly named as one. It exists so a developer can see the evidence
 * screens with real data rather than being told what they would look like.
 *
 * The data is a genuine ledger run through the real pipeline: nothing is
 * inserted directly into trades, equity_points or metric_snapshots.
 *
 * Idempotent. Re-running finds the existing run rather than creating another.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  ObjectStore,
  artefacts,
  campaigns,
  deriveObjectKey,
  memberships,
  organisations,
  reportUploads,
  sha256,
  strategies,
  strategyVersions,
  tradingviewVerifications,
} from '@arf/db';
import { parseReport } from '../dist/handlers/parse-report.js';
import { computeEvidence } from '../dist/handlers/compute-evidence.js';

const CSV = [
  'Trade #,Type,Signal,Date/Time,Price USDT,Contracts,Profit USDT',
  '1,Entry long,Long,2024-01-03 15:00,42150.5,0.237,—',
  '1,Exit long,Close,2024-01-05 09:00,43980.1,0.237,433.62',
  '2,Entry short,Short,2024-01-05 09:00,43980.1,0.235,—',
  '2,Exit short,Close,2024-01-08 21:00,44510.9,0.235,(124.75)',
  '3,Entry long,Long,2024-01-10 12:00,44000.0,0.230,—',
  '3,Exit long,Close,2024-01-14 06:00,44913.0,0.230,210.00',
  '4,Entry long,Long,2024-01-16 08:00,45100.0,0.228,—',
  '4,Exit long,Close,2024-01-19 14:00,44380.0,0.228,(164.16)',
  '5,Entry long,Long,2024-01-22 11:00,44500.0,0.231,—',
  '5,Exit long,Close,2024-01-29 17:00,46210.0,0.231,395.01',
].join('\n');

const url = process.env.DATABASE_URL ?? 'postgres://arfos:arfos@localhost:5432/arfos';
const sql = postgres(url, { max: 2, onnotice: () => {} });
const db = drizzle(sql);

const store = new ObjectStore({
  endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET ?? 'arfos-artefacts',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'arfos',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'arfos-local-dev',
  forcePathStyle: true,
});

try {
  const [org] = await db.select().from(organisations).where(eq(organisations.slug, 'dev-org')).limit(1);
  if (!org) throw new Error('Run pnpm db:seed first: the dev organisation does not exist.');

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.organisationId, org.id))
    .limit(1);
  if (!membership) throw new Error('The dev organisation has no members. Run pnpm db:seed.');

  const NAME = 'Sample ingested export';

  let [strategy] = await db.select().from(strategies).where(eq(strategies.name, NAME)).limit(1);

  if (!strategy) {
    const [campaign] = await db
      .insert(campaigns)
      .values({
        organisationId: org.id,
        name: 'Sample ingestion',
        brief: 'A real TradingView export driven through the ingestion pipeline.',
        createdBy: membership.userId,
      })
      .returning();

    [strategy] = await db
      .insert(strategies)
      .values({
        organisationId: org.id,
        campaignId: campaign.id,
        name: NAME,
        family: 'trend_following',
      })
      .returning();
  }

  let [version] = await db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, strategy.id))
    .limit(1);

  const sourceHash = sha256('//@version=6\nstrategy("Sample")');

  if (!version) {
    [version] = await db
      .insert(strategyVersions)
      .values({
        organisationId: org.id,
        strategyId: strategy.id,
        versionNumber: 1,
        definitionHash: sha256('sample-definition'),
        sourceHash,
      })
      .returning();
  }

  let [verification] = await db
    .select()
    .from(tradingviewVerifications)
    .where(eq(tradingviewVerifications.strategyVersionId, version.id))
    .limit(1);

  if (!verification) {
    [verification] = await db
      .insert(tradingviewVerifications)
      .values({
        organisationId: org.id,
        strategyVersionId: version.id,
        requiredSymbol: 'BYBIT:BTCUSDT.P',
        requiredTimeframe: '60',
        requiredSourceHash: sourceHash,
        status: 'AWAITING_UPLOAD',
      })
      .returning();
  }

  const body = Buffer.from(CSV, 'utf8');
  const checksum = sha256(body);
  const objectKey = deriveObjectKey(org.id, 'tradingview_export', checksum);
  await store.putObject(objectKey, body, 'text/csv');

  let [artefact] = await db.select().from(artefacts).where(eq(artefacts.checksum, checksum)).limit(1);
  if (!artefact) {
    [artefact] = await db
      .insert(artefacts)
      .values({
        organisationId: org.id,
        kind: 'tradingview_export',
        objectKey,
        checksum,
        sizeBytes: body.length,
        contentType: 'text/csv',
      })
      .returning();
  }

  let [upload] = await db
    .select()
    .from(reportUploads)
    .where(eq(reportUploads.verificationId, verification.id))
    .limit(1);
  if (!upload) {
    [upload] = await db
      .insert(reportUploads)
      .values({
        verificationId: verification.id,
        artefactId: artefact.id,
        reportType: 'list_of_trades',
      })
      .returning();
  }

  const parsed = await parseReport(db, store, { uploadId: upload.id, organisationId: org.id });
  if (!parsed.runId) throw new Error(`Parse produced no run: ${parsed.skipped ?? 'unknown'}`);

  const evidence = await computeEvidence(db, { runId: parsed.runId });

  console.log(`trades      ${parsed.tradesWritten}`);
  console.log(`equity      ${evidence.equityPoints} points`);
  console.log(`parity      ${evidence.parityVerdict}`);
  if (evidence.warnings.length > 0) console.log(`warnings    ${evidence.warnings.join(' | ')}`);
  console.log(`\nView: http://localhost:3000/strategies/${strategy.id}?tab=equity&version=${version.id}`);
} catch (err) {
  console.error(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  store.destroy();
  await sql.end();
}
