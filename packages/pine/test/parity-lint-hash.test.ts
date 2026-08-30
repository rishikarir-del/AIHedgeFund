import { describe, expect, it } from 'vitest';
import { canonicalisePineSource, hashManifest, hashPineSource } from '../src/hash.js';
import { hasBlockingFindings, lintPineSource } from '../src/lint.js';
import { compareParity, type ParitySide } from '../src/parity.js';

describe('hashing (CLAUDE.md 3.1, 15.3)', () => {
  it('ignores line endings and trailing whitespace', () => {
    const a = '//@version=6\nstrategy("X")\n';
    const b = '//@version=6\r\nstrategy("X")   \r\n\r\n';
    expect(hashPineSource(a)).toBe(hashPineSource(b));
  });

  it('preserves indentation, which is significant in Pine', () => {
    const a = 'if x\n    strategy.entry("L", strategy.long)';
    const b = 'if x\n        strategy.entry("L", strategy.long)';
    expect(hashPineSource(a)).not.toBe(hashPineSource(b));
  });

  it('changes when any real character changes', () => {
    expect(hashPineSource('fast = 20')).not.toBe(hashPineSource('fast = 21'));
  });

  it('hashes manifests independently of key order', () => {
    expect(hashManifest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashManifest({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('canonicalisation is idempotent', () => {
    const once = canonicalisePineSource('a  \r\nb\r\n\r\n');
    expect(canonicalisePineSource(once)).toBe(once);
  });
});

describe('Pine lint (CLAUDE.md 12.2)', () => {
  const VALID = [
    '//@version=6',
    'strategy("Valid", pyramiding=0, commission_value=0.05, margin_long=100, margin_short=100)',
    'fast = ta.ema(close, 20)',
    'if ta.crossover(fast, ta.ema(close, 50))',
    '    strategy.entry("L", strategy.long)',
  ].join('\n');

  it('passes a compliant script', () => {
    expect(lintPineSource(VALID)).toEqual([]);
  });

  it('flags lookahead as a hard error', () => {
    const findings = lintPineSource(`${VALID}\nhtf = request.security(syminfo.tickerid, "D", close, lookahead=barmerge.lookahead_on)`);
    expect(findings.map((f) => f.code)).toContain('lookahead_on');
    expect(hasBlockingFindings(findings)).toBe(true);
  });

  it('flags a negative history offset', () => {
    const findings = lintPineSource(`${VALID}\nfuture = close[-1]`);
    expect(findings.map((f) => f.code)).toContain('negative_offset');
  });

  it('flags pyramiding above zero', () => {
    const source = VALID.replace('pyramiding=0', 'pyramiding=3');
    expect(lintPineSource(source).map((f) => f.code)).toContain('pyramiding_declared_nonzero');
  });

  it('flags a missing cost model, which flatters results', () => {
    const source = VALID.replace(', commission_value=0.05', '');
    expect(lintPineSource(source).map((f) => f.code)).toContain('missing_cost_model');
  });

  it('flags a missing version directive', () => {
    expect(lintPineSource(VALID.replace('//@version=6', '')).map((f) => f.code)).toContain(
      'missing_version',
    );
  });

  it('does not flag a rule name that only appears in a comment', () => {
    const findings = lintPineSource(`${VALID}\n// never use barmerge.lookahead_on here`);
    expect(findings.map((f) => f.code)).not.toContain('lookahead_on');
  });

  it('treats request.security as a warning, not a blocker', () => {
    const findings = lintPineSource(`${VALID}\nhtf = request.security(syminfo.tickerid, "D", close)`);
    expect(findings.find((f) => f.code === 'request_security_present')?.severity).toBe('warning');
    expect(hasBlockingFindings(findings)).toBe(false);
  });
});

describe('parity (CLAUDE.md 15.3)', () => {
  const IDENTICAL: ParitySide = {
    sourceHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    symbol: 'BYBIT:BTCUSDT.P',
    timeframe: '60',
    fromTs: 1704067200000,
    toTs: 1735689600000,
    commissionValue: 0.05,
    sizingDescription: 'percent_of_equity:100',
    executionMode: 'bar_close',
    tradeCount: 204,
    netProfit: '1988.64',
  };

  it('passes when everything matches', () => {
    const report = compareParity(IDENTICAL, IDENTICAL);
    expect(report.verdict).toBe('PASS');
    expect(report.firstDivergence).toBeNull();
  });

  it('stops at the source hash, not at a downstream metric', () => {
    const other = { ...IDENTICAL, sourceHash: 'c'.repeat(64), netProfit: '99.99', tradeCount: 3 };
    const report = compareParity(IDENTICAL, other);
    expect(report.verdict).toBe('FAIL');
    // The point of 15.3: report the first divergence, not the loudest one.
    expect(report.firstDivergence?.field).toBe('sourceHash');
    expect(report.checkedFields).toEqual(['sourceHash']);
  });

  it('checks identity in the documented order', () => {
    const report = compareParity(IDENTICAL, { ...IDENTICAL, timeframe: '240' });
    expect(report.firstDivergence?.field).toBe('timeframe');
    expect(report.checkedFields).toEqual(['sourceHash', 'manifestHash', 'symbol', 'timeframe']);
  });

  it('reports INSUFFICIENT_DATA when a field is absent, never PASS', () => {
    const report = compareParity(IDENTICAL, { ...IDENTICAL, manifestHash: null });
    expect(report.verdict).toBe('INSUFFICIENT_DATA');
  });

  it('fails on a trade-count mismatch once identity agrees', () => {
    const report = compareParity(IDENTICAL, { ...IDENTICAL, tradeCount: 203 });
    expect(report.verdict).toBe('FAIL');
    expect(report.firstDivergence?.field).toBe('tradeCount');
  });

  it('warns on a small net-profit difference and fails on a large one', () => {
    expect(compareParity(IDENTICAL, { ...IDENTICAL, netProfit: '1990.00' }).verdict).toBe('WARN');
    expect(compareParity(IDENTICAL, { ...IDENTICAL, netProfit: '2500.00' }).verdict).toBe('FAIL');
  });
});
