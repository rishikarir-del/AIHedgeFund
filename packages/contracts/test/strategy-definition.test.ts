import { describe, expect, it } from 'vitest';
import {
  StrategyDefinitionSchema,
  assertParametersDeclared,
  type StrategyDefinition,
} from '../src/strategy-definition.js';

/**
 * Verbatim from AI_RESEARCH_HEDGE_FUND_SPEC.md section 9.1. If the contract
 * cannot parse the specification's own example, the contract is wrong.
 */
const SPEC_EXAMPLE = {
  schemaVersion: '1.0.0',
  strategy: {
    name: 'Example Trend Pullback',
    family: 'trend_following',
    thesis: 'Enter pullbacks in a confirmed higher-timeframe trend.',
    directions: ['long', 'short'],
  },
  market: {
    assetClass: 'crypto',
    symbols: ['BYBIT:BTCUSDT.P'],
    timeframe: '60',
    timezone: 'Etc/UTC',
    session: '0000-2359:1234567',
    chartType: 'standard_ohlc',
  },
  signals: {
    trend: {
      type: 'ema_relation',
      fastLength: { parameter: 'fast_length' },
      slowLength: { parameter: 'slow_length' },
    },
    longEntry: 'trend_fast_above_slow AND pullback_recovery AND confirmed_bar',
    shortEntry: 'trend_fast_below_slow AND pullback_rejection AND confirmed_bar',
  },
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
    leverage: 3,
    stopLoss: { type: 'atr_multiple', valueParameter: 'stop_atr' },
    takeProfit: { type: 'risk_multiple', valueParameter: 'target_r' },
    oneStopOneTarget: true,
  },
  costs: { commissionType: 'percent', commissionValue: 0.06, slippageTicks: 2 },
  parameters: [
    { key: 'fast_length', type: 'int', default: 20, min: 10, max: 50, step: 5 },
    { key: 'slow_length', type: 'int', default: 100, min: 60, max: 200, step: 10 },
    { key: 'stop_atr', type: 'float', default: 2.0, min: 1.0, max: 4.0, step: 0.25 },
    { key: 'target_r', type: 'float', default: 2.0, min: 1.0, max: 4.0, step: 0.25 },
  ],
  segments: { warmupBars: 300, selectionMode: 'rolling_walk_forward', embargoBars: 10 },
  falsification: [
    'Out-of-sample net profit is non-positive.',
    'Performance exists only in one calendar segment.',
    'Neighbouring parameters collapse.',
    'Realistic costs remove the edge.',
  ],
};

describe('StrategyDefinitionSchema', () => {
  it('accepts the specification section 9.1 example', () => {
    const parsed = StrategyDefinitionSchema.safeParse(SPEC_EXAMPLE);
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  });

  it('rejects pyramiding above zero (spec 25 policy default)', () => {
    const bad = { ...SPEC_EXAMPLE, execution: { ...SPEC_EXAMPLE.execution, pyramiding: 2 } };
    expect(StrategyDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects calc_on_every_tick (CLAUDE.md 12.2 hard lint error)', () => {
    const bad = { ...SPEC_EXAMPLE, execution: { ...SPEC_EXAMPLE.execution, calcOnEveryTick: true } };
    expect(StrategyDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unbounded numeric parameter (spec 9.2)', () => {
    const bad = {
      ...SPEC_EXAMPLE,
      parameters: [{ key: 'fast_length', type: 'int', default: 20 }, ...SPEC_EXAMPLE.parameters.slice(1)],
    };
    expect(StrategyDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects free-form logic in an entry expression (spec 9.2)', () => {
    const bad = {
      ...SPEC_EXAMPLE,
      signals: { ...SPEC_EXAMPLE.signals, longEntry: 'close > ta.ema(close, 20) * 1.5' },
    };
    expect(StrategyDefinitionSchema.safeParse(bad).success).toBe(false);
  });
});

describe('assertParametersDeclared', () => {
  const definition = StrategyDefinitionSchema.parse(SPEC_EXAMPLE);

  it('finds no problems in the spec example', () => {
    expect(assertParametersDeclared(definition)).toEqual({ undeclared: [], unused: [] });
  });

  it('detects a parameter referenced but never declared (spec 9.2)', () => {
    const tampered: StrategyDefinition = {
      ...definition,
      parameters: definition.parameters.filter((p) => p.key !== 'stop_atr'),
    };
    expect(assertParametersDeclared(tampered).undeclared).toEqual(['stop_atr']);
  });

  it('detects a declared parameter nothing references', () => {
    const tampered: StrategyDefinition = {
      ...definition,
      parameters: [
        ...definition.parameters,
        { key: 'unused_knob', type: 'int', default: 1, min: 0, max: 10 },
      ],
    };
    expect(assertParametersDeclared(tampered).unused).toEqual(['unused_knob']);
  });
});
