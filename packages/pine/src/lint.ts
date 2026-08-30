/**
 * Pine static checks.
 *
 * CLAUDE.md 12.2 lists the hard errors and 12.3 the warnings. These run before
 * a revision is stored, so a script that repaints or hides its cost model
 * cannot become evidence in the first place.
 *
 * Deliberately conservative: these are textual checks on source, not a Pine
 * parser, so each rule targets a pattern that is unambiguous in practice. A
 * missed detection is acceptable; a false accusation that blocks valid work is
 * not, and anything subtler belongs in review.
 */

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  readonly code: string;
  readonly severity: LintSeverity;
  readonly detail: string;
  readonly line?: number | undefined;
}

interface Rule {
  readonly code: string;
  readonly severity: LintSeverity;
  readonly detail: string;
  readonly pattern: RegExp;
}

/** 12.2: treat as hard errors unless an approved exception exists. */
const PRESENCE_ERRORS: readonly Rule[] = [
  {
    code: 'lookahead_on',
    severity: 'error',
    detail: 'barmerge.lookahead_on reads future data and repaints.',
    pattern: /barmerge\.lookahead_on/,
  },
  {
    code: 'calc_on_every_tick',
    severity: 'error',
    detail: 'calc_on_every_tick must not be enabled; results stop being reproducible.',
    pattern: /calc_on_every_tick\s*=\s*true/,
  },
  {
    code: 'pyramiding_declared_nonzero',
    severity: 'error',
    detail: 'pyramiding must be 0 (spec 25 policy default).',
    pattern: /pyramiding\s*=\s*[1-9]/,
  },
  {
    code: 'negative_offset',
    severity: 'error',
    detail: 'A negative history offset reads forward in time.',
    pattern: /\[\s*-\s*\d+\s*\]/,
  },
];

/** 12.2: required declarations, checked by absence. */
const REQUIRED_DECLARATIONS: readonly Rule[] = [
  {
    code: 'missing_version',
    severity: 'error',
    detail: 'Source must declare //@version=6.',
    pattern: /\/\/@version\s*=\s*6/,
  },
  {
    code: 'missing_strategy_declaration',
    severity: 'error',
    detail: 'Source must contain a strategy() declaration.',
    pattern: /\bstrategy\s*\(/,
  },
  {
    code: 'missing_cost_model',
    severity: 'error',
    detail: 'Commission must be declared explicitly; an unstated cost model flatters results.',
    pattern: /commission_value\s*=/,
  },
  {
    code: 'missing_margin',
    severity: 'error',
    detail: 'Margin must be declared explicitly.',
    pattern: /margin_long\s*=/,
  },
];

const WARNINGS: readonly Rule[] = [
  {
    code: 'request_security_present',
    severity: 'warning',
    detail: 'request.security carries higher-timeframe repainting risk; confirm the value is confirmed.',
    pattern: /request\.security\s*\(/,
  },
  {
    code: 'high_leverage',
    severity: 'warning',
    detail: 'Leverage above 10 is declared; confirm this is intentional.',
    pattern: /leverage\s*=\s*(?:[1-9]\d{1,})/,
  },
  {
    code: 'non_standard_chart',
    severity: 'warning',
    detail: 'Heikin Ashi or Renko inputs produce fills that do not exist on standard candles.',
    pattern: /heikinashi|renko|kagi|pointfigure/i,
  },
];

export function lintPineSource(source: string): readonly LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = source.split(/\r?\n/);

  for (const rule of [...PRESENCE_ERRORS, ...WARNINGS]) {
    const index = lines.findIndex((line) => rule.pattern.test(stripComment(line)));
    if (index >= 0) {
      findings.push({
        code: rule.code,
        severity: rule.severity,
        detail: rule.detail,
        line: index + 1,
      });
    }
  }

  for (const rule of REQUIRED_DECLARATIONS) {
    if (!rule.pattern.test(source)) {
      findings.push({ code: rule.code, severity: rule.severity, detail: rule.detail });
    }
  }

  return findings;
}

export function hasBlockingFindings(findings: readonly LintFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/** Avoids flagging a rule name mentioned in a comment. */
function stripComment(line: string): string {
  const index = line.indexOf('//');
  // Keep the //@version directive, which is a comment by syntax but a declaration by meaning.
  if (line.trimStart().startsWith('//@version')) return line;
  return index >= 0 ? line.slice(0, index) : line;
}
