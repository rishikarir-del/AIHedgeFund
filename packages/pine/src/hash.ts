/**
 * Source and manifest hashing.
 *
 * CLAUDE.md 3.1 makes a strategy version immutable and 15.3 starts parity
 * comparison with source-hash identity, so hashing must be canonical: the same
 * logical script must hash identically regardless of line endings or trailing
 * whitespace, and any real change must alter the hash.
 */
import { createHash } from 'node:crypto';

/**
 * Normalises only what is semantically irrelevant in Pine: line endings, a
 * trailing newline, and trailing spaces on each line. Indentation is
 * significant in Pine and is deliberately preserved.
 */
export function canonicalisePineSource(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export function hashPineSource(source: string): string {
  return createHash('sha256').update(canonicalisePineSource(source), 'utf8').digest('hex');
}

/**
 * Hashes a settings manifest. Keys are sorted so that object insertion order,
 * which carries no meaning, cannot change the hash. Values are serialised via
 * JSON with no whitespace for the same reason.
 */
export function hashManifest(manifest: Readonly<Record<string, unknown>>): string {
  const canonical = JSON.stringify(sortKeysDeep(manifest));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
}
