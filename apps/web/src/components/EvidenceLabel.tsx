/**
 * Evidence labelling primitives.
 *
 * CLAUDE.md 18.1 requires in-sample, validation, final holdout, forward,
 * gross, net, simulated, paper, TradingView and local-runner all to be
 * labelled, and 26 forbids merging reported and independently calculated
 * values into one unlabelled number.
 *
 * These components exist so a screen cannot render a figure without stating
 * its scope and provenance: the number and its label are one component, not
 * two things a developer might forget to pair.
 */
import type { ReactElement } from 'react';

export type EvidenceScope =
  | 'IN_SAMPLE'
  | 'VALIDATION'
  | 'OUT_OF_SAMPLE'
  | 'FINAL_HOLDOUT'
  | 'FORWARD';

export type ValueProvenance = 'tradingview' | 'arf_calculated' | 'mcp_engine' | 'local_runner';

const SCOPE_LABELS: Readonly<Record<EvidenceScope, string>> = {
  IN_SAMPLE: 'In-sample',
  VALIDATION: 'Validation',
  OUT_OF_SAMPLE: 'Out-of-sample',
  FINAL_HOLDOUT: 'Final holdout',
  FORWARD: 'Forward (paper)',
};

const PROVENANCE_LABELS: Readonly<Record<ValueProvenance, string>> = {
  tradingview: 'TradingView reported',
  arf_calculated: 'ARF calculated',
  mcp_engine: 'Engine reported',
  local_runner: 'Local runner',
};

export function ScopeBadge({ scope }: { scope: EvidenceScope }): ReactElement {
  return (
    <span className="badge" data-scope={scope}>
      {SCOPE_LABELS[scope]}
    </span>
  );
}

export interface EvidenceValueProps {
  readonly label: string;
  /** Already formatted. Never a raw float for money (section 7.4). */
  readonly value: string | null;
  readonly scope: EvidenceScope;
  readonly provenance: ValueProvenance;
  /** Whether the figure is net of costs. Ambiguity here misleads (18.1). */
  readonly net?: boolean;
}

/**
 * A single figure with its scope and provenance attached.
 *
 * A null value renders as "not calculated" rather than as zero. A zero that
 * means unknown is precisely the defect that produced a reported runup of 0 on
 * a profitable run.
 */
export function EvidenceValue({
  label,
  value,
  scope,
  provenance,
  net,
}: EvidenceValueProps): ReactElement {
  return (
    <div className="evidence-value">
      <dt>
        {label}
        {net === undefined ? null : <span className="qualifier">{net ? ' (net)' : ' (gross)'}</span>}
      </dt>
      <dd>
        {value === null ? <em className="unknown">not calculated</em> : value}
        <ScopeBadge scope={scope} />
        <span className="provenance">{PROVENANCE_LABELS[provenance]}</span>
      </dd>
    </div>
  );
}

/**
 * Renders reported and calculated figures side by side, never merged.
 * Section 26: never merge local-runner and TradingView results without a
 * parity report, and 18.1 forbids one unlabelled number.
 */
export function ComparedValue({
  label,
  reported,
  calculated,
  reportedFrom,
  scope,
}: {
  readonly label: string;
  readonly reported: string | null;
  readonly calculated: string | null;
  readonly reportedFrom: ValueProvenance;
  readonly scope: EvidenceScope;
}): ReactElement {
  const disagrees = reported !== null && calculated !== null && reported !== calculated;

  return (
    <div className="compared-value" data-disagrees={disagrees}>
      <EvidenceValue label={label} value={reported} scope={scope} provenance={reportedFrom} />
      <EvidenceValue label={label} value={calculated} scope={scope} provenance="arf_calculated" />
      {disagrees ? (
        <p className="divergence-note" role="status">
          These figures disagree. The parity report records which is authoritative.
        </p>
      ) : null}
    </div>
  );
}
