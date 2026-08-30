'use client';

/**
 * Committee decision form.
 *
 * CLAUDE.md 18.3: the dialog must show the exact version, evidence status,
 * validator recommendation, hard failures, the strongest rejection case and
 * override status -- and must not permit a one-click approval that hides the
 * evidence.
 *
 * That last rule is enforced structurally rather than by layout. Approval is
 * unavailable until the reviewer has written a rationale AND ticked an
 * explicit acknowledgement. When hard failures exist, approval is unavailable
 * at any rationale length: the server would refuse it anyway, and offering a
 * button that cannot succeed teaches people to click through warnings.
 */
import { useState, type ReactElement } from 'react';

export interface HardFail {
  readonly code: string;
  readonly detail: string;
}

export function DecisionForm({
  versionId,
  versionNumber,
  hardFails,
  evidenceComplete,
  apiBaseUrl,
}: {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly hardFails: readonly HardFail[];
  readonly evidenceComplete: boolean;
  readonly apiBaseUrl: string;
}): ReactElement {
  const [rationale, setRationale] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [rejectionCase, setRejectionCase] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blocked = hardFails.length > 0 || !evidenceComplete;
  const canApprove = !blocked && acknowledged && rationale.trim().length >= 20;
  const canReject = rationale.trim().length >= 20;

  async function submit(to: 'PAPER_APPROVED' | 'REJECTED'): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`${apiBaseUrl}/v1/decisions`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          // A decision is a command; a retry must not record it twice.
          'idempotency-key': `decision-${versionId}-${to}`,
        },
        body: JSON.stringify({
          strategyVersionId: versionId,
          to,
          rationale,
          ...(rejectionCase ? { rejectionCase } : {}),
        }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const fails = (body?.hardFails ?? []) as HardFail[];
        setResult(
          `Refused: ${body?.detail ?? response.status}${
            fails.length > 0 ? ` (${fails.map((f) => f.code).join(', ')})` : ''
          }`,
        );
        return;
      }
      setResult(`Recorded. Decision ${body?.id ?? ''}`);
    } catch (error) {
      setResult(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <h2>Decision on version {versionNumber}</h2>

      {blocked ? (
        <div className="error-panel" role="alert">
          <p>
            <strong>Approval is unavailable for this version.</strong>
          </p>
          <ul>
            {!evidenceComplete ? <li>Required evidence is missing.</li> : null}
            {hardFails.map((fail) => (
              <li key={fail.code}>
                <strong>{fail.code}</strong>: {fail.detail}
              </li>
            ))}
          </ul>
          <p>Rejection remains available, and a rationale is still required.</p>
        </div>
      ) : null}

      <p>
        <label htmlFor="rationale">
          Rationale <span className="provenance">(at least 20 characters)</span>
        </label>
        <br />
        <textarea
          id="rationale"
          rows={4}
          style={{ width: '100%' }}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="State what the evidence shows and why it supports this decision."
        />
      </p>

      <p>
        <label htmlFor="rejection-case">
          Strongest case against approval <span className="provenance">(recorded either way)</span>
        </label>
        <br />
        <textarea
          id="rejection-case"
          rows={3}
          style={{ width: '100%' }}
          value={rejectionCase}
          onChange={(event) => setRejectionCase(event.target.value)}
          placeholder="The most convincing reason this strategy should not proceed."
        />
      </p>

      {!blocked ? (
        <p>
          <label>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />{' '}
            I have reviewed the evidence above, including the parity report and metric scopes.
          </label>
        </p>
      ) : null}

      <p style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={!canApprove || busy} onClick={() => void submit('PAPER_APPROVED')}>
          Approve for paper testing
        </button>
        <button type="button" disabled={!canReject || busy} onClick={() => void submit('REJECTED')}>
          Reject
        </button>
      </p>

      {result ? (
        <p role="status" aria-live="polite" className="divergence-note">
          {result}
        </p>
      ) : null}

      <p className="subtitle">
        Approval permits paper forward testing only. It is not authorisation to deploy capital, and
        no role in this system can grant that.
      </p>
    </form>
  );
}
