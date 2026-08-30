import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('matches the UUIDv7 shape the contracts package validates', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(uuidv7()).toMatch(UUID_V7);
    }
  });

  it('encodes the supplied timestamp in the leading 48 bits', () => {
    const when = Date.UTC(2026, 7, 30, 12, 0, 0);
    const hex = uuidv7(when).replace(/-/g, '').slice(0, 12);
    expect(Number.parseInt(hex, 16)).toBe(when);
  });

  it('sorts chronologically, which cursor pagination depends on', () => {
    const early = uuidv7(Date.UTC(2026, 0, 1));
    const late = uuidv7(Date.UTC(2026, 11, 31));
    expect(early < late).toBe(true);
  });

  it('does not collide within a single millisecond', () => {
    const fixed = Date.UTC(2026, 7, 30);
    const generated = new Set(Array.from({ length: 5000 }, () => uuidv7(fixed)));
    expect(generated.size).toBe(5000);
  });
});
