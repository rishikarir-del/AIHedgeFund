/**
 * TradingView report parser.
 *
 * CLAUDE.md 15.2 sets the rules this implements: identify the report type,
 * detect delimiter and locale safely, reject ambiguous numeric formats,
 * preserve the raw upload, emit warnings, and never guess an unknown column's
 * meaning.
 *
 * The last rule is why this returns a discriminated failure rather than a
 * best-effort parse. A silently mis-mapped column produces numbers that look
 * plausible and are wrong, which is the worst possible outcome for a system
 * whose purpose is trustworthy evidence.
 */

export type ReportType = 'performance_summary' | 'list_of_trades';

export interface ParseWarning {
  readonly code: string;
  readonly detail: string;
  readonly row?: number | undefined;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T; readonly warnings: readonly ParseWarning[] }
  | { readonly ok: false; readonly code: ParseFailureCode; readonly detail: string };

export type ParseFailureCode =
  | 'empty_file'
  | 'unknown_report_type'
  | 'ambiguous_delimiter'
  | 'ambiguous_number_format'
  | 'unknown_required_column'
  | 'malformed_row';

export interface ParsedTrade {
  readonly tradeNumber: number;
  readonly type: string;
  readonly signal: string;
  readonly dateTime: string;
  readonly price: string;
  readonly contracts: string;
  readonly profit: string | null;
}

/** Column adapters are versioned so an export format change is additive (15.2). */
export const LIST_OF_TRADES_ADAPTER_VERSION = '1.0.0';

const TRADE_COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  tradeNumber: ['trade #', 'trade#', 'trade number', '#'],
  type: ['type'],
  signal: ['signal'],
  dateTime: ['date/time', 'date time', 'datetime', 'date'],
  price: ['price', 'price usdt', 'price usd'],
  contracts: ['contracts', 'quantity', 'qty'],
  profit: ['profit', 'profit usdt', 'profit usd', 'p&l', 'pnl'],
};

/**
 * Detects the delimiter by counting candidates in the header. A file where two
 * candidates appear equally often is ambiguous and is refused rather than
 * guessed at.
 */
export function detectDelimiter(headerLine: string): ParseResult<string> {
  const candidates = [',', ';', '\t'];
  const counts = candidates.map((d) => ({ delimiter: d, count: headerLine.split(d).length - 1 }));
  const ranked = counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);

  if (ranked.length === 0) {
    return { ok: false, code: 'ambiguous_delimiter', detail: 'No known delimiter found in header.' };
  }
  if (ranked.length > 1 && ranked[0]!.count === ranked[1]!.count) {
    return {
      ok: false,
      code: 'ambiguous_delimiter',
      detail: `Delimiters ${ranked[0]!.delimiter} and ${ranked[1]!.delimiter} appear equally often.`,
    };
  }
  return { ok: true, data: ranked[0]!.delimiter, warnings: [] };
}

/**
 * Converts a TradingView numeric cell to a plain decimal string.
 *
 * Refuses anything genuinely ambiguous. "1,234" is the important case: it is
 * 1234 under a US export and 1.234 under a European one, and there is no way
 * to tell from the cell alone. 15.2 says reject rather than guess.
 */
export function parseNumeric(raw: string): ParseResult<string> {
  const cleaned = raw.trim().replace(/[$€£%\s]/g, '').replace(/−/g, '-');
  if (cleaned === '' || cleaned === '—' || cleaned === '-') {
    return { ok: true, data: '0', warnings: [] };
  }

  const negative = /^\(.*\)$/.test(cleaned);
  const body = negative ? cleaned.slice(1, -1) : cleaned;

  const hasComma = body.includes(',');
  const hasDot = body.includes('.');

  let normalised: string;
  if (hasComma && hasDot) {
    // Whichever separator appears last is the decimal point.
    normalised =
      body.lastIndexOf(',') > body.lastIndexOf('.')
        ? body.replace(/\./g, '').replace(',', '.')
        : body.replace(/,/g, '');
  } else if (hasComma) {
    const [, fraction = ''] = body.split(',');
    // Exactly three digits after a lone comma is unresolvable.
    if (fraction.length === 3) {
      return {
        ok: false,
        code: 'ambiguous_number_format',
        detail: `"${raw}" is ambiguous: a lone comma with three following digits may be a thousands or a decimal separator.`,
      };
    }
    normalised = body.replace(',', '.');
  } else {
    normalised = body;
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalised)) {
    return { ok: false, code: 'ambiguous_number_format', detail: `Unrecognised numeric value: "${raw}".` };
  }

  const signed = negative ? `-${normalised}` : normalised;
  return { ok: true, data: signed, warnings: [] };
}

export function identifyReportType(content: string): ParseResult<ReportType> {
  const firstLine = content.split(/\r?\n/, 1)[0]?.toLowerCase() ?? '';
  if (firstLine.includes('trade #') || firstLine.includes('trade#')) {
    return { ok: true, data: 'list_of_trades', warnings: [] };
  }
  // A Performance Summary is a metric-name column plus All/Long/Short columns.
  if (/\ball\b/.test(firstLine) && /\blong\b/.test(firstLine) && /\bshort\b/.test(firstLine)) {
    return { ok: true, data: 'performance_summary', warnings: [] };
  }
  return {
    ok: false,
    code: 'unknown_report_type',
    detail: 'Header matches neither a List of Trades nor a Performance Summary export.',
  };
}

function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/** Maps header cells to known fields, refusing to guess at unknown ones. */
function mapColumns(header: readonly string[]): ParseResult<Record<string, number>> {
  const normalised = header.map((h) => h.toLowerCase().trim());
  const mapping: Record<string, number> = {};

  for (const [field, aliases] of Object.entries(TRADE_COLUMN_ALIASES)) {
    const index = normalised.findIndex((cell) => aliases.includes(cell));
    if (index >= 0) mapping[field] = index;
  }

  for (const required of ['tradeNumber', 'type', 'dateTime', 'price'] as const) {
    if (mapping[required] === undefined) {
      return {
        ok: false,
        code: 'unknown_required_column',
        detail: `Required column "${required}" not found. Headers seen: ${header.join(', ')}.`,
      };
    }
  }

  return { ok: true, data: mapping, warnings: [] };
}

export function parseListOfTrades(content: string): ParseResult<readonly ParsedTrade[]> {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, code: 'empty_file', detail: 'File has no data rows.' };
  }

  const delimiter = detectDelimiter(lines[0]!);
  if (!delimiter.ok) return delimiter;

  const header = splitRow(lines[0]!, delimiter.data);
  const mapping = mapColumns(header);
  if (!mapping.ok) return mapping;

  const warnings: ParseWarning[] = [];
  const unmapped = header.filter(
    (_, i) => !Object.values(mapping.data).includes(i),
  );
  if (unmapped.length > 0) {
    // Surfaced, never guessed at.
    warnings.push({
      code: 'unmapped_columns',
      detail: `Ignored unrecognised columns: ${unmapped.join(', ')}.`,
    });
  }

  const trades: ParsedTrade[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitRow(lines[i]!, delimiter.data);
    if (cells.length !== header.length) {
      return {
        ok: false,
        code: 'malformed_row',
        detail: `Row ${i + 1} has ${cells.length} cells, expected ${header.length}.`,
      };
    }

    const numberCell = parseNumeric(cells[mapping.data['tradeNumber']!] ?? '');
    if (!numberCell.ok) return numberCell;
    const priceCell = parseNumeric(cells[mapping.data['price']!] ?? '');
    if (!priceCell.ok) return priceCell;

    const contractsIndex = mapping.data['contracts'];
    const contractsCell = contractsIndex === undefined ? null : parseNumeric(cells[contractsIndex] ?? '');
    if (contractsCell && !contractsCell.ok) return contractsCell;

    const profitIndex = mapping.data['profit'];
    const profitCell = profitIndex === undefined ? null : parseNumeric(cells[profitIndex] ?? '');
    if (profitCell && !profitCell.ok) return profitCell;

    const signalIndex = mapping.data['signal'];

    trades.push({
      tradeNumber: Number(numberCell.data),
      type: cells[mapping.data['type']!] ?? '',
      signal: signalIndex === undefined ? '' : (cells[signalIndex] ?? ''),
      dateTime: cells[mapping.data['dateTime']!] ?? '',
      price: priceCell.data,
      contracts: contractsCell?.ok ? contractsCell.data : '0',
      profit: profitCell?.ok ? profitCell.data : null,
    });
  }

  return { ok: true, data: trades, warnings };
}
