/**
 * Verification, backtest runs and evidence.
 *
 * CLAUDE.md 7.4 forbids binary floating point for authoritative monetary
 * totals, so every money column is `numeric`. CLAUDE.md 15.3 requires reported
 * and independently calculated values to stay separate, so `backtest_runs`
 * holds what the source claimed and `metric_snapshots` holds what ARF computed.
 * Merging them is what the parity report exists to prevent.
 */
import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../ids.js';
import { artefacts, strategyVersions } from './research.js';
import { organisations } from './identity.js';

/** See ADR 0002. Every run records where its numbers came from. */
export const backtestSourceEnum = pgEnum('backtest_source', [
  'tradingview_csv',
  'mcp_engine',
  'local_runner',
]);

export const evidenceScopeEnum = pgEnum('evidence_scope', [
  'IN_SAMPLE',
  'VALIDATION',
  'OUT_OF_SAMPLE',
  'FINAL_HOLDOUT',
  'FORWARD',
]);

export const parityVerdictEnum = pgEnum('parity_verdict', [
  'PASS',
  'WARN',
  'FAIL',
  'INSUFFICIENT_DATA',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'REQUESTED',
  'AWAITING_UPLOAD',
  'PARSING',
  'PARSED',
  'FAILED',
]);

export const tradingviewVerifications = pgTable(
  'tradingview_verifications',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'restrict' }),
    status: verificationStatusEnum('status').notNull().default('REQUESTED'),
    /** Exactly what the uploader must reproduce in TradingView (spec 13.2). */
    requiredSymbol: text('required_symbol').notNull(),
    requiredTimeframe: text('required_timeframe').notNull(),
    requiredSourceHash: text('required_source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tv_verifications_version_idx').on(t.strategyVersionId)],
);

export const reportUploads = pgTable(
  'report_uploads',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    verificationId: uuid('verification_id')
      .notNull()
      .references(() => tradingviewVerifications.id, { onDelete: 'cascade' }),
    artefactId: uuid('artefact_id')
      .notNull()
      .references(() => artefacts.id, { onDelete: 'restrict' }),
    reportType: text('report_type').notNull(),
    /** Parser warnings are preserved verbatim, never normalised away (CLAUDE.md 13). */
    parserWarnings: jsonb('parser_warnings').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('report_uploads_verification_type_uq').on(t.verificationId, t.reportType)],
);

export const backtestRuns = pgTable(
  'backtest_runs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'restrict' }),
    strategyVersionId: uuid('strategy_version_id')
      .notNull()
      .references(() => strategyVersions.id, { onDelete: 'restrict' }),
    source: backtestSourceEnum('source').notNull(),
    /** Per-source identity: upload checksum, engine result id, or runner version. */
    sourceIdentity: jsonb('source_identity').notNull(),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    initialCapital: numeric('initial_capital', { precision: 20, scale: 8 }).notNull(),
    plan: jsonb('plan').notNull(),
    codeHash: text('code_hash').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    datasetHash: text('dataset_hash').notNull(),
    /** What the source claimed. Never merged into metric_snapshots. */
    reportedMetrics: jsonb('reported_metrics').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('backtest_runs_version_idx').on(t.strategyVersionId, t.createdAt)],
);

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    direction: text('direction').notNull(),
    entryTime: timestamp('entry_time', { withTimezone: true }).notNull(),
    exitTime: timestamp('exit_time', { withTimezone: true }),
    entryPrice: numeric('entry_price', { precision: 20, scale: 8 }).notNull(),
    exitPrice: numeric('exit_price', { precision: 20, scale: 8 }),
    quantity: numeric('quantity', { precision: 20, scale: 8 }).notNull(),
    profit: numeric('profit', { precision: 20, scale: 8 }),
  },
  (t) => [unique('trades_run_sequence_uq').on(t.runId, t.sequence)],
);

export const equityPoints = pgTable(
  'equity_points',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    barTime: timestamp('bar_time', { withTimezone: true }).notNull(),
    equity: numeric('equity', { precision: 20, scale: 8 }).notNull(),
  },
  (t) => [unique('equity_points_run_bar_uq').on(t.runId, t.barTime)],
);

export const drawdownPoints = pgTable(
  'drawdown_points',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    barTime: timestamp('bar_time', { withTimezone: true }).notNull(),
    drawdown: numeric('drawdown', { precision: 20, scale: 8 }).notNull(),
    drawdownPct: numeric('drawdown_pct', { precision: 10, scale: 6 }).notNull(),
  },
  (t) => [unique('drawdown_points_run_bar_uq').on(t.runId, t.barTime)],
);

/**
 * Independently calculated metrics. CLAUDE.md 14 requires an explicit
 * calculation version and a stated scope, and forbids comparing across
 * incompatible scopes, so both are mandatory columns.
 */
export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    scope: evidenceScopeEnum('scope').notNull(),
    calculationVersion: text('calculation_version').notNull(),
    metrics: jsonb('metrics').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('metric_snapshots_run_scope_calc_uq').on(t.runId, t.scope, t.calculationVersion)],
);

export const parityReports = pgTable('parity_reports', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  runId: uuid('run_id')
    .notNull()
    .references(() => backtestRuns.id, { onDelete: 'cascade' }),
  verdict: parityVerdictEnum('verdict').notNull(),
  /** Spec 15.3: the FIRST divergence, not only aggregate differences. */
  firstDivergence: jsonb('first_divergence'),
  checkedFields: jsonb('checked_fields').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
