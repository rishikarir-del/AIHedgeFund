import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  identifyReportType,
  parseListOfTrades,
  parseNumeric,
} from '../src/tradingview-csv.js';

describe('parseNumeric (CLAUDE.md 15.2: reject ambiguous formats)', () => {
  it('parses plain values', () => {
    expect(parseNumeric('1234.56')).toMatchObject({ ok: true, data: '1234.56' });
    expect(parseNumeric('-88.10')).toMatchObject({ ok: true, data: '-88.10' });
  });

  it('strips currency symbols and percent signs', () => {
    expect(parseNumeric('$1234.56')).toMatchObject({ ok: true, data: '1234.56' });
    expect(parseNumeric('19.89%')).toMatchObject({ ok: true, data: '19.89' });
  });

  it('reads parentheses as negative, the accounting convention', () => {
    expect(parseNumeric('(590.47)')).toMatchObject({ ok: true, data: '-590.47' });
  });

  it('resolves US format where both separators are present', () => {
    expect(parseNumeric('18,964.26')).toMatchObject({ ok: true, data: '18964.26' });
  });

  it('resolves European format where both separators are present', () => {
    expect(parseNumeric('18.964,26')).toMatchObject({ ok: true, data: '18964.26' });
  });

  /** The case that must never be guessed: 1,234 is 1234 or 1.234 depending on locale. */
  it('refuses a lone comma with exactly three following digits', () => {
    const result = parseNumeric('1,234');
    expect(result).toMatchObject({ ok: false, code: 'ambiguous_number_format' });
  });

  it('accepts a lone comma that cannot be a thousands separator', () => {
    expect(parseNumeric('1,5')).toMatchObject({ ok: true, data: '1.5' });
  });

  it('treats an em dash as zero, as TradingView writes for empty cells', () => {
    expect(parseNumeric('—')).toMatchObject({ ok: true, data: '0' });
  });

  it('refuses junk rather than coercing it', () => {
    expect(parseNumeric('n/a')).toMatchObject({ ok: false });
    expect(parseNumeric('1.2.3')).toMatchObject({ ok: false });
  });
});

describe('detectDelimiter', () => {
  it('detects a comma', () => {
    expect(detectDelimiter('Trade #,Type,Price')).toMatchObject({ ok: true, data: ',' });
  });

  it('detects a semicolon, as European exports use', () => {
    expect(detectDelimiter('Trade #;Type;Price')).toMatchObject({ ok: true, data: ';' });
  });

  it('refuses a header where two delimiters appear equally often', () => {
    expect(detectDelimiter('a,b;c')).toMatchObject({ ok: false, code: 'ambiguous_delimiter' });
  });
});

describe('identifyReportType', () => {
  it('recognises a List of Trades', () => {
    expect(identifyReportType('Trade #,Type,Signal,Date/Time\n1,Entry long,,2024')).toMatchObject({
      ok: true,
      data: 'list_of_trades',
    });
  });

  it('recognises a Performance Summary', () => {
    expect(identifyReportType('Title,All,Long,Short\nNet Profit,100,60,40')).toMatchObject({
      ok: true,
      data: 'performance_summary',
    });
  });

  it('refuses an unrecognised header', () => {
    expect(identifyReportType('foo,bar,baz')).toMatchObject({ ok: false, code: 'unknown_report_type' });
  });
});

describe('parseListOfTrades', () => {
  const CSV = [
    'Trade #,Type,Signal,Date/Time,Price USDT,Contracts,Profit USDT',
    '1,Entry long,Long,2024-01-03 15:00,42150.5,0.237,—',
    '2,Exit long,Close,2024-01-05 09:00,43980.1,0.237,433.62',
    '3,Entry short,Short,2024-01-05 09:00,43980.1,0.235,—',
    '4,Exit short,Close,2024-01-08 21:00,44510.9,0.235,(124.75)',
  ].join('\n');

  it('parses rows with aliased column names', () => {
    const result = parseListOfTrades(CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(4);
    expect(result.data[1]).toMatchObject({ tradeNumber: 2, price: '43980.1', profit: '433.62' });
  });

  it('reads a parenthesised loss as negative', () => {
    const result = parseListOfTrades(CSV);
    if (!result.ok) throw new Error('expected success');
    expect(result.data[3]?.profit).toBe('-124.75');
  });

  it('refuses a file whose required column is missing (15.2: never guess)', () => {
    const missing = 'Type,Signal,Date/Time,Price\nEntry long,Long,2024-01-03,42150.5';
    expect(parseListOfTrades(missing)).toMatchObject({ ok: false, code: 'unknown_required_column' });
  });

  it('warns about unmapped columns instead of silently ignoring them', () => {
    const extra = [
      'Trade #,Type,Signal,Date/Time,Price,Contracts,Profit,Run-up,Drawdown',
      '1,Entry long,Long,2024-01-03 15:00,42150.5,0.237,100,50,20',
    ].join('\n');
    const result = parseListOfTrades(extra);
    if (!result.ok) throw new Error('expected success');
    expect(result.warnings.map((w) => w.code)).toContain('unmapped_columns');
    expect(result.warnings[0]?.detail).toMatch(/Run-up/);
  });

  it('refuses a row with the wrong cell count rather than padding it', () => {
    const ragged = 'Trade #,Type,Date/Time,Price\n1,Entry long,2024-01-03';
    expect(parseListOfTrades(ragged)).toMatchObject({ ok: false, code: 'malformed_row' });
  });

  it('propagates an ambiguous number as a parse failure', () => {
    const ambiguous = 'Trade #,Type,Date/Time,Price\n1,Entry long,2024-01-03,"1,234"';
    expect(parseListOfTrades(ambiguous)).toMatchObject({ ok: false, code: 'ambiguous_number_format' });
  });

  it('handles a semicolon-delimited European export', () => {
    const european = [
      'Trade #;Type;Date/Time;Price;Profit',
      '1;Entry long;2024-01-03 15:00;42150,5;433,62',
    ].join('\n');
    const result = parseListOfTrades(european);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0]?.price).toBe('42150.5');
  });
});
