/**
 * Parity comparison.
 *
 * CLAUDE.md 15.3 fixes the order: identity first -- source hash, manifest,
 * symbol, timeframe, date range, costs, sizing, execution mode -- and only
 * then trade sequence. It also requires reporting the FIRST divergence rather
 * than an aggregate diff, because if the source hashes differ then every
 * downstream metric difference is a consequence, not a finding.
 */

export type ParityVerdict = 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT_DATA';

export interface ParitySide {
  readonly sourceHash: string | null;
  readonly manifestHash: string | null;
  readonly symbol: string | null;
  readonly timeframe: string | null;
  readonly fromTs: number | null;
  readonly toTs: number | null;
  readonly commissionValue: number | null;
  readonly sizingDescription: string | null;
  readonly executionMode: string | null;
  readonly tradeCount: number | null;
  readonly netProfit: string | null;
}

export interface Divergence {
  readonly field: string;
  readonly reported: string;
  readonly calculated: string;
}

export interface ParityReport {
  readonly verdict: ParityVerdict;
  readonly firstDivergence: Divergence | null;
  readonly checkedFields: readonly string[];
}

/** Net profit within this fraction is a WARN, beyond it a FAIL. */
export const NET_PROFIT_WARN_TOLERANCE = 0.005;

const IDENTITY_FIELDS = [
  'sourceHash',
  'manifestHash',
  'symbol',
  'timeframe',
  'fromTs',
  'toTs',
  'commissionValue',
  'sizingDescription',
  'executionMode',
] as const satisfies readonly (keyof ParitySide)[];

export function compareParity(reported: ParitySide, calculated: ParitySide): ParityReport {
  const checked: string[] = [];

  for (const field of IDENTITY_FIELDS) {
    const a = reported[field];
    const b = calculated[field];

    // A field absent on either side cannot be compared. Say so rather than
    // treating absence as agreement.
    if (a === null || b === null) {
      return {
        verdict: 'INSUFFICIENT_DATA',
        firstDivergence: {
          field,
          reported: a === null ? '(absent)' : String(a),
          calculated: b === null ? '(absent)' : String(b),
        },
        checkedFields: [...checked, field],
      };
    }

    checked.push(field);
    if (a !== b) {
      // Identity mismatch: stop here. Comparing metrics between two different
      // things produces findings that are true but useless.
      return {
        verdict: 'FAIL',
        firstDivergence: { field, reported: String(a), calculated: String(b) },
        checkedFields: checked,
      };
    }
  }

  if (reported.tradeCount === null || calculated.tradeCount === null) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      firstDivergence: {
        field: 'tradeCount',
        reported: reported.tradeCount === null ? '(absent)' : String(reported.tradeCount),
        calculated: calculated.tradeCount === null ? '(absent)' : String(calculated.tradeCount),
      },
      checkedFields: checked,
    };
  }

  checked.push('tradeCount');
  if (reported.tradeCount !== calculated.tradeCount) {
    return {
      verdict: 'FAIL',
      firstDivergence: {
        field: 'tradeCount',
        reported: String(reported.tradeCount),
        calculated: String(calculated.tradeCount),
      },
      checkedFields: checked,
    };
  }

  if (reported.netProfit === null || calculated.netProfit === null) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      firstDivergence: {
        field: 'netProfit',
        reported: reported.netProfit ?? '(absent)',
        calculated: calculated.netProfit ?? '(absent)',
      },
      checkedFields: checked,
    };
  }

  checked.push('netProfit');
  const reportedNet = Number(reported.netProfit);
  const calculatedNet = Number(calculated.netProfit);
  const denominator = Math.abs(reportedNet);
  const relative = denominator === 0 ? Math.abs(calculatedNet) : Math.abs(reportedNet - calculatedNet) / denominator;

  if (relative === 0) {
    return { verdict: 'PASS', firstDivergence: null, checkedFields: checked };
  }

  return {
    verdict: relative <= NET_PROFIT_WARN_TOLERANCE ? 'WARN' : 'FAIL',
    firstDivergence: {
      field: 'netProfit',
      reported: reported.netProfit,
      calculated: calculated.netProfit,
    },
    checkedFields: checked,
  };
}
