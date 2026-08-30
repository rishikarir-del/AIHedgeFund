import { describe, expect, it } from 'vitest';
import { Decimal, sum } from '../src/decimal.js';

describe('Decimal exactness (CLAUDE.md 7.4)', () => {
  it('adds values that binary floating point gets wrong', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a JS number.
    const result = Decimal.fromString('0.1').add(Decimal.fromString('0.2'));
    expect(result.toString()).toBe('0.30000000');
    expect(result.cmp(Decimal.fromString('0.3'))).toBe(0);
  });

  it('sums a long series without drift', () => {
    const cents = Array.from({ length: 10_000 }, () => Decimal.fromString('0.01'));
    expect(sum(cents).toString()).toBe('100.00000000');
  });

  it('preserves large monetary totals exactly', () => {
    const a = Decimal.fromString('18964.25952055');
    const b = Decimal.fromString('16975.61974655');
    expect(a.sub(b).toString()).toBe('1988.63977400');
  });

  it('rejects an ambiguous input rather than coercing it', () => {
    for (const bad of ['1,5', '1e5', '', 'abc', '1.2.3', ' ']) {
      expect(() => Decimal.fromString(bad)).toThrow();
    }
  });

  it('refuses to silently truncate excess precision', () => {
    expect(() => Decimal.fromString('1.123456789')).toThrow(/decimal places/);
  });

  it('returns null on division by zero rather than Infinity', () => {
    expect(Decimal.fromString('5').div(Decimal.ZERO)).toBeNull();
  });

  it('rounds half away from zero symmetrically', () => {
    const third = Decimal.fromString('1').div(Decimal.fromString('3'));
    expect(third?.toString()).toBe('0.33333333');
    const negThird = Decimal.fromString('-1').div(Decimal.fromString('3'));
    expect(negThird?.toString()).toBe('-0.33333333');
  });
});
