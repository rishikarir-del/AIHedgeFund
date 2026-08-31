import { describe, expect, it, vi } from 'vitest';
import { SegmentPlanError, planWalkForward } from '../src/segments.js';
import { BudgetExceededError, runWalkForward } from '../src/segment-runner.js';
import type { BacktestResult, BacktestRunner } from '../src/types.js';

const YEAR = { from: '2024-01-01', to: '2025-01-01' };

const ROLLING = {
  ...YEAR,
  model: 'rolling_walk_forward' as const,
  inSampleDays: 90,
  outOfSampleDays: 30,
  embargoDays: 5,
};

describe('planWalkForward', () => {
  it('produces paired in-sample and out-of-sample windows per fold', () => {
    const plan = planWalkForward(ROLLING);

    expect(plan.foldCount).toBeGreaterThan(2);
    expect(plan.runCount).toBe(plan.windows.length);
    expect(plan.windows.length).toBe(plan.foldCount * 2);

    const fold0 = plan.windows.filter((w) => w.foldId === 0);
    expect(fold0.map((w) => w.scope)).toEqual(['IN_SAMPLE', 'OUT_OF_SAMPLE']);
  });

  it('leaves an embargo gap between training and test (spec 12.3)', () => {
    const plan = planWalkForward(ROLLING);
    const [inSample, outOfSample] = plan.windows;

    const gapDays =
      (Date.parse(outOfSample!.from) - Date.parse(inSample!.to)) / 86_400_000;
    expect(gapDays).toBe(5);
  });

  it('refuses a plan with no embargo, rather than quietly allowing leakage', () => {
    expect(() => planWalkForward({ ...ROLLING, embargoDays: 0 })).toThrow(SegmentPlanError);
    expect(() => planWalkForward({ ...ROLLING, embargoDays: 0 })).toThrow(/embargo/);
  });

  it('advances by the test window so each day is tested out of sample once', () => {
    const plan = planWalkForward(ROLLING);
    const oos = plan.windows.filter((w) => w.scope === 'OUT_OF_SAMPLE');

    for (let i = 1; i < oos.length; i += 1) {
      // Consecutive test windows abut rather than overlap.
      expect(oos[i]!.from).toBe(oos[i - 1]!.to);
    }
  });

  it('anchors the training start when the anchored model is used', () => {
    const plan = planWalkForward({ ...ROLLING, model: 'anchored_walk_forward' });
    const inSample = plan.windows.filter((w) => w.scope === 'IN_SAMPLE');

    expect(inSample.length).toBeGreaterThan(1);
    // Every fold trains from the same origin; only the end moves.
    expect(inSample[1]!.from).toBe(inSample[0]!.from);
    expect(Date.parse(inSample[1]!.to)).toBeGreaterThan(Date.parse(inSample[0]!.to));
  });

  it('rolls the training start when the rolling model is used', () => {
    const plan = planWalkForward(ROLLING);
    const inSample = plan.windows.filter((w) => w.scope === 'IN_SAMPLE');
    expect(Date.parse(inSample[1]!.from)).toBeGreaterThan(Date.parse(inSample[0]!.from));
  });

  it('warns when too few folds fit to distinguish degradation from chance', () => {
    const plan = planWalkForward({
      from: '2024-01-01',
      to: '2024-07-01',
      model: 'rolling_walk_forward',
      inSampleDays: 90,
      outOfSampleDays: 60,
      embargoDays: 5,
    });
    expect(plan.foldCount).toBeLessThan(3);
    expect(plan.warnings.join(' ')).toMatch(/Fewer than three/);
  });

  it('refuses a range shorter than one fold', () => {
    expect(() => planWalkForward({ ...ROLLING, to: '2024-02-01' })).toThrow(/range/i);
  });
});

function stubRunner(netProfitByScope: (scope: string, fold: number) => number): BacktestRunner {
  return {
    capabilities: () => ({
      name: 'stub',
      version: '1',
      pineVersions: [6],
      supportsParameterSweep: false,
      supportsCancel: false,
      claimsTradingViewParity: false,
    }),
    compile: async () => ({ ok: true, warnings: [] }),
    cancel: async () => undefined,
    run: async (input) => {
      const fold = Number(/fold (\d+)/.exec(input.notes ?? '')?.[1] ?? 0);
      const scope = input.notes?.includes('out_of_sample') ? 'OUT_OF_SAMPLE' : 'IN_SAMPLE';
      return {
        runnerName: 'stub',
        runnerVersion: '1',
        codeHash: 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        datasetHash: 'c'.repeat(64),
        environmentHash: 'd'.repeat(64),
        parameters: {},
        executionSettings: {},
        trades: [],
        equity: [],
        reportedMetrics: { netProfit: netProfitByScope(scope, fold) },
        warnings: [],
        durationMs: 1,
        externalResultId: `stub-${fold}-${scope}`,
      } satisfies BacktestResult;
    },
  };
}

const RUN_CONFIG = {
  pineSource: '//@version=6',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  initialCapital: '10000',
  maxRuns: 100,
};

describe('runWalkForward', () => {
  it('refuses to start when the plan exceeds the budget', async () => {
    const plan = planWalkForward(ROLLING);
    await expect(
      runWalkForward(stubRunner(() => 100), plan, { ...RUN_CONFIG, maxRuns: 2 }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('spends nothing when the budget refuses the plan', async () => {
    const plan = planWalkForward(ROLLING);
    const runner = stubRunner(() => 100);
    const spy = vi.spyOn(runner, 'run');

    await runWalkForward(runner, plan, { ...RUN_CONFIG, maxRuns: 1 }).catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it('computes retention per fold', async () => {
    const plan = planWalkForward(ROLLING);
    // Training makes 1000, test keeps half.
    const report = await runWalkForward(
      stubRunner((scope) => (scope === 'IN_SAMPLE' ? 1000 : 500)),
      plan,
      RUN_CONFIG,
    );

    expect(report.folds[0]?.retention).toBeCloseTo(0.5, 6);
    expect(report.foldsOutOfSampleProfitable).toBe(report.plan.foldCount);
  });

  it('flags the overfitting signature when no fold survives out of sample', async () => {
    const plan = planWalkForward(ROLLING);
    const report = await runWalkForward(
      stubRunner((scope) => (scope === 'IN_SAMPLE' ? 1000 : -200)),
      plan,
      RUN_CONFIG,
    );

    expect(report.foldsOutOfSampleProfitable).toBe(0);
    expect(report.warnings.join(' ')).toMatch(/expected signature of an overfitted strategy/);
  });

  it('reports null retention rather than dividing by a non-positive in-sample result', async () => {
    const plan = planWalkForward(ROLLING);
    const report = await runWalkForward(
      stubRunner((scope) => (scope === 'IN_SAMPLE' ? 0 : 500)),
      plan,
      RUN_CONFIG,
    );
    // "Kept 50% of nothing" is not a statement about degradation.
    expect(report.folds[0]?.retention).toBeNull();
  });

  it('continues after a failing fold and counts the credit as spent', async () => {
    const plan = planWalkForward(ROLLING);
    const runner = stubRunner(() => 100);
    let calls = 0;
    runner.run = async () => {
      calls += 1;
      if (calls === 2) throw new Error('engine unavailable');
      return {
        runnerName: 'stub',
        runnerVersion: '1',
        codeHash: 'a'.repeat(64),
        manifestHash: 'b'.repeat(64),
        datasetHash: 'c'.repeat(64),
        environmentHash: 'd'.repeat(64),
        parameters: {},
        executionSettings: {},
        trades: [],
        equity: [],
        reportedMetrics: { netProfit: 100 },
        warnings: [],
        durationMs: 1,
        externalResultId: null,
      } satisfies BacktestResult;
    };

    const report = await runWalkForward(runner, plan, RUN_CONFIG);

    expect(report.runsSpent).toBe(plan.runCount);
    expect(report.warnings.join(' ')).toMatch(/failed: engine unavailable/);
    expect(report.outcomes.filter((o) => o.error !== null)).toHaveLength(1);
  });
});
