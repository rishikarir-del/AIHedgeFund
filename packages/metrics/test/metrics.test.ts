import { describe, expect, it } from 'vitest';
import { calculateMetrics, reconstructEquity, type TradeInput } from '../src/metrics.js';

function trade(
  sequence: number,
  profit: string | null,
  entryTime = '2024-01-01T00:00:00.000Z',
  exitTime: string | null = '2024-01-01T04:00:00.000Z',
): TradeInput {
  return { sequence, direction: 'long', entryTime, exitTime, profit };
}

describe('hand-calculated fixture', () => {
  // Three wins totalling 300, two losses totalling -120.
  const trades = [
    trade(1, '100.00'),
    trade(2, '-50.00'),
    trade(3, '150.00'),
    trade(4, '-70.00'),
    trade(5, '50.00'),
  ];
  const equity = reconstructEquity(trades, '1000.00');
  const metrics = calculateMetrics(trades, equity, '1000.00');

  it('counts trades and outcomes', () => {
    expect(metrics.closedTradeCount).toBe(5);
    expect(metrics.winningTrades).toBe(3);
    expect(metrics.losingTrades).toBe(2);
  });

  it('computes gross figures with loss as a positive magnitude', () => {
    expect(metrics.grossProfit).toBe('300.00000000');
    expect(metrics.grossLoss).toBe('120.00000000');
    expect(metrics.netProfit).toBe('180.00000000');
  });

  it('computes profit factor as 300 / 120', () => {
    expect(metrics.profitFactor).toBeCloseTo(2.5, 8);
  });

  it('computes averages and payoff ratio', () => {
    expect(metrics.averageWin).toBe('100.00000000');
    expect(metrics.averageLoss).toBe('-60.00000000');
    expect(metrics.payoffRatio).toBeCloseTo(100 / 60, 6);
  });

  it('computes win rate as a percentage, not a ratio', () => {
    expect(metrics.winRatePct).toBeCloseTo(60, 8);
  });
});

describe('equity reconstruction', () => {
  it('accumulates profit onto the declared initial capital', () => {
    const points = reconstructEquity([trade(1, '100.00'), trade(2, '-30.00')], '1000.00');
    expect(points.map((p) => p.equity)).toEqual(['1100.00000000', '1070.00000000']);
  });

  it('excludes open trades from the curve', () => {
    const points = reconstructEquity([trade(1, '100.00'), trade(2, null, undefined, null)], '1000.00');
    expect(points).toHaveLength(1);
  });
});

describe('drawdown and runup', () => {
  it('measures peak-to-trough drawdown', () => {
    // 1000 -> 1200 -> 900 -> 1100. Max drawdown is 300 from the 1200 peak.
    const trades = [trade(1, '200.00'), trade(2, '-300.00'), trade(3, '200.00')];
    const metrics = calculateMetrics(trades, reconstructEquity(trades, '1000.00'), '1000.00');
    expect(metrics.maxDrawdown).toBe('300.00000000');
    expect(metrics.maxDrawdownPct).toBeCloseTo(25, 6); // 300 / 1200
  });

  /**
   * Regression test (CLAUDE.md 21.4). An external engine reported
   * maxRunup: 0 on a run that finished up 19.89%, which is impossible.
   * Runup must never be zero on a curve that rose.
   */
  it('never reports zero runup on a profitable curve', () => {
    const trades = [trade(1, '200.00'), trade(2, '-300.00'), trade(3, '400.00')];
    const metrics = calculateMetrics(trades, reconstructEquity(trades, '1000.00'), '1000.00');

    expect(metrics.netProfit).toBe('300.00000000');
    expect(metrics.maxRunup).not.toBe('0.00000000');
    // Trough 900 -> peak 1300 is a runup of 400.
    expect(metrics.maxRunup).toBe('400.00000000');
    expect(metrics.maxRunupPct).toBeCloseTo((400 / 900) * 100, 6);
  });

  it('reports null percentages rather than zero when no equity exists', () => {
    const metrics = calculateMetrics([], [], '1000.00');
    expect(metrics.maxDrawdownPct).toBeNull();
    expect(metrics.maxRunupPct).toBeNull();
    expect(metrics.warnings.join(' ')).toMatch(/No equity points/);
  });
});

describe('no silent data loss (CLAUDE.md 14)', () => {
  it('warns about open trades instead of dropping them quietly', () => {
    const metrics = calculateMetrics(
      [trade(1, '100.00'), trade(2, null, undefined, null)],
      [],
      '1000.00',
    );
    expect(metrics.openTradeCount).toBe(1);
    expect(metrics.closedTradeCount).toBe(1);
    expect(metrics.warnings.join(' ')).toMatch(/still open/);
  });

  it('counts zero-duration trades rather than discarding them', () => {
    const instant = trade(1, '10.00', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    const metrics = calculateMetrics([instant], [], '1000.00');
    expect(metrics.closedTradeCount).toBe(1);
    expect(metrics.averageHoldingDurationMs).toBe(0);
  });

  it('warns and excludes unparseable timestamps', () => {
    const broken = trade(1, '10.00', 'not-a-date', 'also-not-a-date');
    const metrics = calculateMetrics([broken], [], '1000.00');
    expect(metrics.averageHoldingDurationMs).toBeNull();
    expect(metrics.warnings.join(' ')).toMatch(/unparseable/);
  });

  it('returns null profit factor with no losses, and says why', () => {
    const metrics = calculateMetrics([trade(1, '100.00')], [], '1000.00');
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.warnings.join(' ')).toMatch(/no losing trades/);
  });
});

describe('streaks and monthly returns', () => {
  it('finds the longest run of consecutive losses', () => {
    const trades = [
      trade(1, '-10.00'),
      trade(2, '-10.00'),
      trade(3, '50.00'),
      trade(4, '-10.00'),
      trade(5, '-10.00'),
      trade(6, '-10.00'),
    ];
    expect(calculateMetrics(trades, [], '1000.00').longestLosingStreak).toBe(3);
  });

  it('buckets by UTC month regardless of server timezone (CLAUDE.md 7.3)', () => {
    const trades = [
      trade(1, '100.00', '2024-01-31T20:00:00.000Z', '2024-01-31T23:30:00.000Z'),
      // 00:30 UTC on 1 Feb is still January in some local zones. Must bucket as February.
      trade(2, '50.00', '2024-02-01T00:00:00.000Z', '2024-02-01T00:30:00.000Z'),
    ];
    const metrics = calculateMetrics(trades, [], '1000.00');
    expect(metrics.monthlyReturns).toEqual([
      { month: '2024-01', netProfit: '100.00000000' },
      { month: '2024-02', netProfit: '50.00000000' },
    ]);
  });
});

describe('reconciliation against a real engine result', () => {
  /**
   * Aggregates from trader.dev result 01M17XT37S9N50KKMX7DEG8XBJ: 35 wins
   * averaging 541.835986301429 and 169 losses averaging -100.447454121598.
   * This checks our arithmetic reproduces an independently produced total,
   * which is the point of the parity comparison in spec 15.3.
   */
  const trades: TradeInput[] = [
    ...Array.from({ length: 35 }, (_, i) => trade(i + 1, '541.83598630')),
    ...Array.from({ length: 169 }, (_, i) => trade(i + 36, '-100.44745412')),
  ];
  const metrics = calculateMetrics(trades, reconstructEquity(trades, '10000.00'), '10000.00');

  it('reproduces the reported trade count', () => {
    expect(metrics.closedTradeCount).toBe(204);
  });

  it('reproduces gross profit and gross loss to the cent', () => {
    expect(Number(metrics.grossProfit)).toBeCloseTo(18964.26, 2);
    expect(Number(metrics.grossLoss)).toBeCloseTo(16975.62, 2);
  });

  it('reproduces net profit and profit factor', () => {
    expect(Number(metrics.netProfit)).toBeCloseTo(1988.64, 2);
    expect(metrics.profitFactor).toBeCloseTo(1.117, 3);
  });

  it('reproduces the 17.16% win rate', () => {
    expect(metrics.winRatePct).toBeCloseTo(17.157, 3);
  });
});
