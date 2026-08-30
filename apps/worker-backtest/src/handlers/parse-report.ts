/**
 * Report parse and trade normalisation.
 *
 * Reads the preserved raw upload from object storage, parses it, and writes a
 * normalised trade ledger. CLAUDE.md 3.6 requires the job to be idempotent, so
 * every insert relies on the unique constraints in @arf/db rather than a
 * "have I run before" flag: re-running the job converges on the same rows.
 *
 * 3.2 forbids a worker changing lifecycle state. This writes evidence and
 * emits an event; whether that evidence is sufficient to move a version is the
 * workflow engine's decision, made through the API.
 */
import { and, eq } from 'drizzle-orm';
import {
  ObjectStore,
  artefacts,
  backtestRuns,
  outboxEvents,
  reportUploads,
  trades,
  tradingviewVerifications,
  type Database,
} from '@arf/db';
import { parseListOfTrades, identifyReportType, type ParsedTrade } from '@arf/pine';

export interface ParseReportPayload {
  readonly uploadId: string;
  readonly organisationId: string;
}

export interface ParseReportResult {
  readonly runId: string | null;
  readonly tradesWritten: number;
  readonly warnings: readonly string[];
  readonly skipped: string | null;
}

/**
 * TradingView writes local times without an offset. Treating them as UTC is a
 * declared assumption rather than a guess, and it is recorded in the run's
 * plan so a later comparison knows what was assumed (section 7.3).
 */
function toIso(raw: string): string {
  const normalised = raw.trim().replace(' ', 'T');
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalised) ? normalised : `${normalised}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

export async function parseReport(
  db: Database,
  store: ObjectStore,
  payload: ParseReportPayload,
): Promise<ParseReportResult> {
  const [upload] = await db
    .select()
    .from(reportUploads)
    .where(eq(reportUploads.id, payload.uploadId))
    .limit(1);
  if (!upload) return { runId: null, tradesWritten: 0, warnings: [], skipped: 'upload_not_found' };

  const [artefact] = await db
    .select()
    .from(artefacts)
    .where(
      and(eq(artefacts.id, upload.artefactId), eq(artefacts.organisationId, payload.organisationId)),
    )
    .limit(1);
  if (!artefact) return { runId: null, tradesWritten: 0, warnings: [], skipped: 'artefact_not_found' };

  const [verification] = await db
    .select()
    .from(tradingviewVerifications)
    .where(eq(tradingviewVerifications.id, upload.verificationId))
    .limit(1);
  if (!verification) {
    return { runId: null, tradesWritten: 0, warnings: [], skipped: 'verification_not_found' };
  }

  const body = (await store.getObject(artefact.objectKey)).toString('utf8');

  const kind = identifyReportType(body);
  if (!kind.ok) {
    // A parse failure is evidence too. It is recorded, not swallowed.
    await db.insert(outboxEvents).values({
      eventType: 'report.parse_failed',
      payload: { uploadId: payload.uploadId, code: kind.code, detail: kind.detail },
    });
    return { runId: null, tradesWritten: 0, warnings: [kind.detail], skipped: kind.code };
  }

  if (kind.data !== 'list_of_trades') {
    // Performance Summary carries reported metrics rather than a ledger; it is
    // attached to the run elsewhere and produces no trades.
    return { runId: null, tradesWritten: 0, warnings: [], skipped: 'not_a_trade_ledger' };
  }

  const parsed = parseListOfTrades(body);
  if (!parsed.ok) {
    await db.insert(outboxEvents).values({
      eventType: 'report.parse_failed',
      payload: { uploadId: payload.uploadId, code: parsed.code, detail: parsed.detail },
    });
    return { runId: null, tradesWritten: 0, warnings: [parsed.detail], skipped: parsed.code };
  }

  return db.transaction(async (tx) => {
    // One run per (version, upload checksum). Re-running the job finds the
    // existing run rather than creating a second one.
    const existing = await tx
      .select()
      .from(backtestRuns)
      .where(
        and(
          eq(backtestRuns.strategyVersionId, verification.strategyVersionId),
          eq(backtestRuns.codeHash, verification.requiredSourceHash),
        ),
      )
      .limit(1);

    const run =
      existing[0] ??
      (
        await tx
          .insert(backtestRuns)
          .values({
            organisationId: payload.organisationId,
            strategyVersionId: verification.strategyVersionId,
            source: 'tradingview_csv',
            sourceIdentity: { uploadChecksum: artefact.checksum, reportType: upload.reportType },
            symbol: verification.requiredSymbol,
            timeframe: verification.requiredTimeframe,
            initialCapital: '10000.00000000',
            plan: { assumedTimezone: 'UTC', derivedFrom: 'tradingview_export' },
            codeHash: verification.requiredSourceHash,
            manifestHash: verification.requiredSourceHash,
            datasetHash: artefact.checksum,
            reportedMetrics: { warnings: parsed.warnings.map((w) => w.detail) },
          })
          .returning()
      )[0];

    if (!run) throw new Error('Backtest run could not be created');

    const rows = pairTrades(parsed.data).map((trade, index) => ({
      runId: run.id,
      sequence: index + 1,
      direction: trade.direction,
      entryTime: new Date(trade.entryTime),
      exitTime: trade.exitTime ? new Date(trade.exitTime) : null,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      quantity: trade.quantity,
      profit: trade.profit,
    }));

    if (rows.length > 0) {
      // Unique (runId, sequence) makes this converge on retry.
      await tx.insert(trades).values(rows).onConflictDoNothing();
    }

    await tx.insert(outboxEvents).values({
      eventType: 'backtest_run.ingested',
      payload: { runId: run.id, tradeCount: rows.length },
    });

    return {
      runId: run.id,
      tradesWritten: rows.length,
      warnings: parsed.warnings.map((w) => w.detail),
      skipped: null,
    };
  });
}

interface PairedTrade {
  readonly direction: 'long' | 'short';
  readonly entryTime: string;
  readonly exitTime: string | null;
  readonly entryPrice: string;
  readonly exitPrice: string | null;
  readonly quantity: string;
  readonly profit: string | null;
}

/**
 * TradingView emits one row per fill: an entry row then an exit row. A closed
 * trade is the pair. An unmatched entry stays open rather than being dropped,
 * because section 14 forbids silently discarding trades.
 */
export function pairTrades(rows: readonly ParsedTrade[]): readonly PairedTrade[] {
  const paired: PairedTrade[] = [];
  const open = new Map<string, ParsedTrade>();

  for (const row of [...rows].sort((a, b) => a.tradeNumber - b.tradeNumber)) {
    const type = row.type.toLowerCase();
    const key = String(row.tradeNumber);

    if (type.includes('entry')) {
      open.set(key, row);
      continue;
    }

    const entry = open.get(key);
    if (!entry) continue;
    open.delete(key);

    paired.push({
      direction: entry.type.toLowerCase().includes('short') ? 'short' : 'long',
      entryTime: toIso(entry.dateTime),
      exitTime: toIso(row.dateTime),
      entryPrice: entry.price,
      exitPrice: row.price,
      quantity: entry.contracts,
      profit: row.profit,
    });
  }

  for (const entry of open.values()) {
    paired.push({
      direction: entry.type.toLowerCase().includes('short') ? 'short' : 'long',
      entryTime: toIso(entry.dateTime),
      exitTime: null,
      entryPrice: entry.price,
      exitPrice: null,
      quantity: entry.contracts,
      profit: null,
    });
  }

  return paired;
}
