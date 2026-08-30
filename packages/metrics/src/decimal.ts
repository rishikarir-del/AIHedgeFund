/**
 * Fixed-point decimal arithmetic.
 *
 * CLAUDE.md 7.4 forbids binary floating point for authoritative monetary
 * totals. 4 says to avoid introducing a large framework where a small internal
 * abstraction suffices, so this is a BigInt-backed fixed-point type at scale 8,
 * matching the `numeric(20, 8)` columns in @arf/db rather than a general
 * decimal library.
 *
 * Every value is an integer count of 1e-8 units. Addition and subtraction are
 * exact. Multiplication and division round half-away-from-zero at the final
 * step only, which is stated rather than incidental.
 */

export const SCALE = 8;
const FACTOR = 10n ** BigInt(SCALE);

export class Decimal {
  /** Scaled integer: the real value is `units / 1e8`. */
  readonly units: bigint;

  private constructor(units: bigint) {
    this.units = units;
  }

  static readonly ZERO = new Decimal(0n);

  /**
   * Parses a decimal string. Rejects anything ambiguous rather than coercing:
   * CLAUDE.md 15.2 requires the parser to reject ambiguous numeric formats
   * instead of guessing, and the same principle applies here.
   */
  static fromString(value: string): Decimal {
    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error(`Not a decimal string: ${JSON.stringify(value)}`);
    }

    const negative = trimmed.startsWith('-');
    const unsigned = negative ? trimmed.slice(1) : trimmed;
    const [whole = '0', fraction = ''] = unsigned.split('.');

    // Truncation here would silently lose precision, so refuse instead.
    if (fraction.length > SCALE) {
      throw new Error(`More than ${SCALE} decimal places: ${value}`);
    }

    const padded = fraction.padEnd(SCALE, '0');
    const units = BigInt(whole) * FACTOR + BigInt(padded || '0');
    return new Decimal(negative ? -units : units);
  }

  /** Only for values known to be exact in binary floating point, such as counts. */
  static fromInteger(value: number): Decimal {
    if (!Number.isInteger(value)) throw new Error(`Not an integer: ${value}`);
    return new Decimal(BigInt(value) * FACTOR);
  }

  add(other: Decimal): Decimal {
    return new Decimal(this.units + other.units);
  }

  sub(other: Decimal): Decimal {
    return new Decimal(this.units - other.units);
  }

  mul(other: Decimal): Decimal {
    return new Decimal(divRound(this.units * other.units, FACTOR));
  }

  /** Returns null on division by zero rather than Infinity or NaN. */
  div(other: Decimal): Decimal | null {
    if (other.units === 0n) return null;
    return new Decimal(divRound(this.units * FACTOR, other.units));
  }

  abs(): Decimal {
    return this.units < 0n ? new Decimal(-this.units) : this;
  }

  neg(): Decimal {
    return new Decimal(-this.units);
  }

  cmp(other: Decimal): -1 | 0 | 1 {
    if (this.units < other.units) return -1;
    if (this.units > other.units) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  max(other: Decimal): Decimal {
    return this.cmp(other) >= 0 ? this : other;
  }

  min(other: Decimal): Decimal {
    return this.cmp(other) <= 0 ? this : other;
  }

  /** Canonical decimal string, always with exactly SCALE places. */
  toString(): string {
    const negative = this.units < 0n;
    const abs = negative ? -this.units : this.units;
    const whole = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  /**
   * Lossy. Use only for display and for ratios where a float is acceptable,
   * never for a stored monetary total.
   */
  toNumber(): number {
    return Number(this.toString());
  }
}

/** Half-away-from-zero, so -0.5 rounds to -1 and 0.5 rounds to 1. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const remainder = a % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.add(v), Decimal.ZERO);
}
