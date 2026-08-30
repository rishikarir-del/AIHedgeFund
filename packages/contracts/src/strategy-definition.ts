/**
 * Strategy Definition Language, spec section 9.
 *
 * The SDL is the contract between the Strategy Architect and the Pine Engineer.
 * Section 9.2 forbids free-form executable logic, requires every parameter to
 * declare a type and range, and forbids the Pine Engineer adding undeclared
 * parameters. `assertParametersDeclared` enforces that last rule mechanically
 * rather than leaving it to review.
 */
import { z } from 'zod';
import { SchemaVersionSchema } from './common.js';

export const StrategyFamilySchema = z.enum([
  'trend_following',
  'mean_reversion',
  'breakout',
  'market_structure',
  'momentum',
  'volatility',
  'carry',
  'seasonality',
]);

export const DirectionSchema = z.enum(['long', 'short']);

/**
 * A reference to a declared parameter. Signals point at parameters by key
 * instead of embedding literals, so the optimiser has a single source of truth
 * for what is tunable.
 */
export const ParameterRefSchema = z.object({ parameter: z.string().min(1) });

/**
 * Approved expression grammar (spec 9.2). Deliberately restrictive: named
 * boolean terms combined with AND / OR / NOT and parentheses. No arithmetic, no
 * function calls, no bare literals -- anything richer belongs in a declared
 * signal block, not a string.
 */
const EXPRESSION = /^[A-Za-z_][A-Za-z0-9_]*(\s+(AND|OR)\s+(NOT\s+)?[A-Za-z_][A-Za-z0-9_]*)*$/;
export const ExpressionSchema = z
  .string()
  .min(1)
  .regex(EXPRESSION, 'must use the approved expression grammar: TERM (AND|OR) [NOT] TERM');

export const ParameterSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be lower_snake_case'),
    type: z.enum(['int', 'float', 'bool']),
    default: z.union([z.number(), z.boolean()]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
  })
  .refine((p) => (p.type === 'bool' ? typeof p.default === 'boolean' : typeof p.default === 'number'), {
    message: 'default must match the declared type',
  })
  .refine((p) => p.type === 'bool' || (p.min !== undefined && p.max !== undefined), {
    message: 'numeric parameters must declare min and max (spec 9.2: bounded ranges)',
  })
  .refine((p) => p.min === undefined || p.max === undefined || p.min < p.max, {
    message: 'min must be less than max',
  });
export type Parameter = z.infer<typeof ParameterSchema>;

export const MarketSchema = z.object({
  assetClass: z.enum(['crypto', 'forex', 'futures', 'indices', 'metals', 'equities']),
  symbols: z.array(z.string().min(1)).min(1),
  /** TradingView interval notation: "60" is 1h, "240" is 4h, "1D" is daily. */
  timeframe: z.string().min(1),
  timezone: z.string().min(1),
  session: z.string().min(1),
  chartType: z.literal('standard_ohlc'),
});

export const ExecutionSchema = z.object({
  entryOrder: z.enum(['market_next_bar', 'stop', 'limit']),
  /** Spec 25 policy default and CLAUDE.md 12.1 both pin this to 0. */
  pyramiding: z.literal(0),
  allowReversal: z.boolean(),
  processOnClose: z.boolean(),
  /** CLAUDE.md 12.2 treats undeclared calc_on_every_tick as a hard lint error. */
  calcOnEveryTick: z.literal(false),
});

const StopSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('atr_multiple'), valueParameter: z.string().min(1) }),
  z.object({ type: z.literal('percent'), valueParameter: z.string().min(1) }),
  z.object({ type: z.literal('ticks'), valueParameter: z.string().min(1) }),
]);

const TargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('risk_multiple'), valueParameter: z.string().min(1) }),
  z.object({ type: z.literal('atr_multiple'), valueParameter: z.string().min(1) }),
  z.object({ type: z.literal('percent'), valueParameter: z.string().min(1) }),
]);

export const RiskSchema = z.object({
  sizingModel: z.enum(['percent_of_equity', 'fixed_cash', 'fixed_contracts']),
  sizePercent: z.number().positive().max(100),
  leverage: z.number().positive(),
  stopLoss: StopSchema,
  takeProfit: TargetSchema,
  /** Spec 25: one TP and one SL. */
  oneStopOneTarget: z.literal(true),
});

export const CostsSchema = z.object({
  commissionType: z.enum(['percent', 'cash_per_order', 'cash_per_contract']),
  commissionValue: z.number().nonnegative(),
  slippageTicks: z.number().int().nonnegative(),
});

export const SegmentsSchema = z.object({
  warmupBars: z.number().int().nonnegative(),
  selectionMode: z.enum(['fixed_split', 'rolling_walk_forward', 'anchored_walk_forward']),
  embargoBars: z.number().int().nonnegative(),
});

export const StrategyDefinitionSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  strategy: z.object({
    name: z.string().min(1).max(255),
    family: StrategyFamilySchema,
    thesis: z.string().min(1),
    directions: z.array(DirectionSchema).min(1),
  }),
  market: MarketSchema,
  signals: z
    .object({
      longEntry: ExpressionSchema.optional(),
      shortEntry: ExpressionSchema.optional(),
      longExit: ExpressionSchema.optional(),
      shortExit: ExpressionSchema.optional(),
    })
    .catchall(z.unknown()),
  execution: ExecutionSchema,
  risk: RiskSchema,
  costs: CostsSchema,
  parameters: z.array(ParameterSchema).min(1),
  segments: SegmentsSchema,
  /** Spec 7.4: what would falsify this strategy, stated before testing. */
  falsification: z.array(z.string().min(1)).min(1),
});
export type StrategyDefinition = z.infer<typeof StrategyDefinitionSchema>;

export const SDL_SCHEMA_VERSION = '1.0.0';

/** Collect every `{ parameter: "..." }` reference anywhere in the document. */
function collectParameterRefs(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectParameterRefs(item, found);
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  const record = node as Record<string, unknown>;
  const ref = ParameterRefSchema.safeParse(record);
  if (ref.success) {
    found.add(ref.data.parameter);
    return;
  }
  for (const value of Object.values(record)) collectParameterRefs(value, found);
}

/**
 * Spec 9.2: the Pine Engineer may not add undeclared parameters. Returns the
 * keys referenced but never declared, and those declared but never used --
 * CLAUDE.md STYLE forbids dead code, so an unused parameter is also a defect.
 */
export function assertParametersDeclared(definition: StrategyDefinition): {
  undeclared: string[];
  unused: string[];
} {
  const declared = new Set(definition.parameters.map((p) => p.key));
  const referenced = new Set<string>();
  collectParameterRefs(definition, referenced);

  for (const value of [definition.risk.stopLoss.valueParameter, definition.risk.takeProfit.valueParameter]) {
    referenced.add(value);
  }

  return {
    undeclared: [...referenced].filter((key) => !declared.has(key)).sort(),
    unused: [...declared].filter((key) => !referenced.has(key)).sort(),
  };
}
