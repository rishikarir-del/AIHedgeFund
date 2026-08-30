import { describe, expect, it } from 'vitest';
import { pairTrades } from '../src/handlers/parse-report.js';

function row(
  tradeNumber: number,
  type: string,
  dateTime: string,
  price: string,
  profit: string | null,
) {
  return { tradeNumber, type, signal: '', dateTime, price, contracts: '1', profit };
}

describe('pairTrades', () => {
  it('pairs an entry with its exit', () => {
    const paired = pairTrades([
      row(1, 'Entry long', '2024-01-03 15:00', '42150.5', null),
      row(1, 'Exit long', '2024-01-05 09:00', '43980.1', '433.62'),
    ]);

    expect(paired).toHaveLength(1);
    expect(paired[0]).toMatchObject({
      direction: 'long',
      entryPrice: '42150.5',
      exitPrice: '43980.1',
      profit: '433.62',
    });
  });

  it('reads direction from the entry row, not the exit', () => {
    const paired = pairTrades([
      row(2, 'Entry short', '2024-01-05 09:00', '43980.1', null),
      row(2, 'Exit short', '2024-01-08 21:00', '44510.9', '-124.75'),
    ]);
    expect(paired[0]?.direction).toBe('short');
  });

  it('keeps an unmatched entry as an open trade rather than dropping it', () => {
    const paired = pairTrades([
      row(1, 'Entry long', '2024-01-03 15:00', '42150.5', null),
      row(1, 'Exit long', '2024-01-05 09:00', '43980.1', '433.62'),
      row(2, 'Entry long', '2024-01-06 10:00', '44000.0', null),
    ]);

    // Section 14 forbids silently discarding a trade.
    expect(paired).toHaveLength(2);
    const open = paired.find((t) => t.exitTime === null);
    expect(open).toBeDefined();
    expect(open?.profit).toBeNull();
  });

  it('treats a naive timestamp as UTC, a declared assumption', () => {
    const paired = pairTrades([
      row(1, 'Entry long', '2024-01-03 15:00', '1', null),
      row(1, 'Exit long', '2024-01-03 18:00', '2', '10'),
    ]);
    expect(paired[0]?.entryTime).toBe('2024-01-03T15:00:00.000Z');
  });

  it('orders by trade number regardless of input order', () => {
    const paired = pairTrades([
      row(2, 'Entry long', '2024-01-06 10:00', '3', null),
      row(2, 'Exit long', '2024-01-07 10:00', '4', '5'),
      row(1, 'Entry long', '2024-01-03 15:00', '1', null),
      row(1, 'Exit long', '2024-01-04 15:00', '2', '10'),
    ]);
    expect(paired[0]?.entryPrice).toBe('1');
  });
});
