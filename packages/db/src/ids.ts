/**
 * UUIDv7 generation.
 *
 * CLAUDE.md 7.2 requires UUIDv7-compatible IDs. PostgreSQL gained a built-in
 * `uuidv7()` only in version 18, and this project targets 17, so IDs are
 * generated in the application layer instead of by a column default.
 *
 * Layout (RFC 9562): 48-bit big-endian Unix milliseconds, 4-bit version 7,
 * 12 bits of randomness, 2-bit variant, 62 bits of randomness. The leading
 * timestamp is what makes these sort chronologically, which cursor pagination
 * in the API depends on.
 */
import { randomBytes } from 'node:crypto';

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit timestamp, most significant byte first.
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 in the high nibble of byte 6.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 4122 variant in the top two bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
