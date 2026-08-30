/**
 * Backtest plan and run result.
 *
 * The `source` discriminator is the important part. The build prompt assumes
 * results arrive as uploaded TradingView CSV exports; a structured MCP engine
 * (trader.dev) returns them directly instead. Both are modelled here so the
 * choice between them stays open and is recorded per run rather than assumed
 * globally.
 *
 * CLAUDE.md 15.3 requires reported and independently calculated values to stay
 * separate so parity can be evaluated, so `reportedMetrics` is deliberately not
 * merged into the ARF-calculated MetricSnapshot.
 */
import { z } from 'zod';
import {
  EvidenceScopeSchema,
  IsoTimestampSchema,
  MoneySchema,
  PercentSchema,
  SchemaVersionSchema,
  Sha256Schema,
} from './common.js';
import { BacktestRunIdSchema, StrategyVersionIdSchema } from './ids.js';

export const BacktestSourceSchema = z.enum(['tradingview_csv', 'mcp_engine', 'local_runner']);
export type BacktestSource = z.infer<typeof BacktestSourceSchema>;

export const SegmentSchema = z.object({
  scope: EvidenceScopeSchema,
  from: IsoTimestampSchema,
  to: IsoTimestampSchema,
});

export const BacktestPlanSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  strategyVersionId: StrategyVersionIdSchema,
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  initialCapital: MoneySchema,
  segments: z.array(SegmentSchema).min(1),
  parameterSet: z.record(z.string(), z.union([z.number(), z.boolean()])),
  /** Declared before the run, never inferred from results afterwards. */
  costModel: z.object({
    commissionType: z.enum(['percent', 'cash_per_order', 'cash_per_contract']),
    commissionValue: z.number().nonnegative(),
    slippageTicks: z.number().int().nonnegative(),
  }),
});
export type BacktestPlan = z.infer<typeof BacktestPlanSchema>;

export const TradeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  direction: z.enum(['long', 'short']),
  entryTime: IsoTimestampSchema,
  exitTime: IsoTimestampSchema.nullable(),
  entryPrice: MoneySchema,
  exitPrice: MoneySchema.nullable(),
  quantity: MoneySchema,
  /** Net of costs. Null while the position is still open. */
  profit: MoneySchema.nullable(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const EquityPointSchema = z.object({
  barTime: IsoTimestampSchema,
  equity: MoneySchema,
});

/**
 * Whatever the source claimed, preserved verbatim. CLAUDE.md 13 says not to
 * normalise away source-specific warnings, so they are kept as free text.
 */
export const ReportedMetricsSchema = z.object({
  netProfit: MoneySchema.optional(),
  netProfitPct: PercentSchema.optional(),
  maxDrawdown: MoneySchema.optional(),
  maxDrawdownPct: PercentSchema.optional(),
  maxRunup: MoneySchema.optional(),
  maxRunupPct: PercentSchema.optional(),
  totalTrades: z.number().int().nonnegative().optional(),
  profitFactor: z.number().optional(),
  warnings: z.array(z.string()).default([]),
});
export type ReportedMetrics = z.infer<typeof ReportedMetricsSchema>;

const SourceIdentitySchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('tradingview_csv'),
    /** Checksum of the preserved raw upload (build prompt: object storage). */
    uploadChecksum: Sha256Schema,
    reportType: z.enum(['performance_summary', 'list_of_trades']),
  }),
  z.object({
    source: z.literal('mcp_engine'),
    engine: z.string().min(1),
    engineVersion: z.string().min(1),
    /** The engine's own result identifier, for server-side lookup. */
    externalResultId: z.string().min(1),
  }),
  z.object({
    source: z.literal('local_runner'),
    runnerName: z.string().min(1),
    runnerVersion: z.string().min(1),
  }),
]);

export const BacktestRunResultSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  runId: BacktestRunIdSchema,
  strategyVersionId: StrategyVersionIdSchema,
  plan: BacktestPlanSchema,
  identity: SourceIdentitySchema,
  /** Hashes that make a run reproducible (spec 3.5). */
  codeHash: Sha256Schema,
  manifestHash: Sha256Schema,
  datasetHash: Sha256Schema,
  trades: z.array(TradeSchema),
  equity: z.array(EquityPointSchema),
  reportedMetrics: ReportedMetricsSchema,
  createdAt: IsoTimestampSchema,
});
export type BacktestRunResult = z.infer<typeof BacktestRunResultSchema>;

export const BACKTEST_SCHEMA_VERSION = '1.0.0';

export const ParityVerdictSchema = z.enum(['PASS', 'WARN', 'FAIL', 'INSUFFICIENT_DATA']);
export type ParityVerdict = z.infer<typeof ParityVerdictSchema>;

export const ParityReportSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  runId: BacktestRunIdSchema,
  verdict: ParityVerdictSchema,
  /**
   * Spec 15.3: report the FIRST divergence, not only aggregate differences.
   * Null when the verdict is PASS.
   */
  firstDivergence: z
    .object({
      field: z.string().min(1),
      reported: z.string(),
      calculated: z.string(),
    })
    .nullable(),
  checkedFields: z.array(z.string()),
  createdAt: IsoTimestampSchema,
});
export type ParityReport = z.infer<typeof ParityReportSchema>;
