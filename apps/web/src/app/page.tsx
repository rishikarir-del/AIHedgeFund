/**
 * Command Centre.
 *
 * The build prompt asks for campaign counts, a strategy funnel, pending
 * TradingView verifications, jobs, recent decisions, and data/parse failures.
 *
 * Its closing instruction warns against "a beautiful but ungrounded dashboard",
 * and section 27 against one "backed by fake or mutable data". Every figure
 * here is a count of stored rows. Where something cannot be known, the panel
 * says so rather than showing a zero that would read as a fact.
 */
import { serverApiClient } from '../lib/server-client';
import type { DashboardSummary } from '../lib/api-client';

export const dynamic = 'force-dynamic';

/** Stages in lifecycle order. Terminal outcomes are shown apart from the flow. */
const FLOW = [
  'CAMPAIGN_BACKLOG',
  'IDEA_RESEARCH',
  'HYPOTHESIS_DRAFT',
  'PINE_DEVELOPMENT',
  'TRADINGVIEW_VERIFICATION',
  'PAPER_APPROVAL_REVIEW',
  'PAPER_APPROVED',
] as const;

const TERMINAL = ['REJECTED', 'BLOCKED'] as const;

const STATE_LABELS: Readonly<Record<string, string>> = {
  CAMPAIGN_BACKLOG: 'Campaign backlog',
  IDEA_RESEARCH: 'Idea research',
  HYPOTHESIS_DRAFT: 'Hypothesis draft',
  PINE_DEVELOPMENT: 'Pine development',
  TRADINGVIEW_VERIFICATION: 'TradingView verification',
  PAPER_APPROVAL_REVIEW: 'Awaiting committee',
  PAPER_APPROVED: 'Paper approved',
  REJECTED: 'Rejected',
  BLOCKED: 'Blocked',
};

function Funnel({ funnel }: { funnel: DashboardSummary['funnel'] }) {
  const byState = new Map(funnel.map((f) => [f.state, f.count]));
  const peak = Math.max(1, ...funnel.map((f) => f.count));

  const row = (state: string) => {
    const value = byState.get(state) ?? 0;
    return (
      <tr key={state}>
        <th scope="row" style={{ width: '38%', fontWeight: 400 }}>
          {STATE_LABELS[state] ?? state}
        </th>
        <td>
          {/* Decoration only. The number is printed beside it, so the bar
              carries no information a reader could miss. */}
          <div
            aria-hidden="true"
            style={{
              background: value === 0 ? 'transparent' : 'var(--accent)',
              border: value === 0 ? '1px dashed var(--border)' : 'none',
              width: value === 0 ? '100%' : `${Math.max((value / peak) * 100, 3)}%`,
              height: 14,
              borderRadius: 3,
              opacity: value === 0 ? 0.35 : 0.85,
            }}
          />
        </td>
        <td style={{ width: 56, textAlign: 'right' }}>{value}</td>
      </tr>
    );
  };

  return (
    <>
      <table>
        <caption className="sr-only">
          Strategy versions by workflow stage. Every stage is listed, including those with none.
        </caption>
        <tbody>{FLOW.map(row)}</tbody>
      </table>
      <p className="subtitle" style={{ marginTop: 14 }}>
        Outcomes
      </p>
      <table>
        <tbody>{TERMINAL.map(row)}</tbody>
      </table>
    </>
  );
}

function Queues({ queues }: { queues: DashboardSummary['queues'] }) {
  // Null means no broker is configured. That is not the same as an idle queue,
  // and showing zeros would assert something untrue.
  if (queues === null) {
    return (
      <div className="state-machine">
        <p>Queue depth is unavailable.</p>
        <p>
          No broker is configured for this API process, so the jobs panel cannot report anything.
          That is not a claim that the queues are empty.
        </p>
      </div>
    );
  }

  if (queues.length === 0) {
    return <div className="empty">No queues are registered.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Queue</th>
          <th scope="col">Waiting</th>
          <th scope="col">Active</th>
          <th scope="col">Delayed</th>
          <th scope="col">Failed</th>
        </tr>
      </thead>
      <tbody>
        {queues.map((queue) => (
          <tr key={queue.name}>
            <td>{queue.name}</td>
            <td>{queue.waiting}</td>
            <td>{queue.active}</td>
            <td>{queue.delayed}</td>
            <td className={queue.failed > 0 ? 'divergence-note' : undefined}>{queue.failed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function CommandCentrePage() {
  const client = serverApiClient();
  const summary = await client.getDashboard();

  const awaitingCommittee =
    summary.funnel.find((f) => f.state === 'PAPER_APPROVAL_REVIEW')?.count ?? 0;

  return (
    <>
      <h1>Command Centre</h1>
      <p className="subtitle">
        Every figure is a count of stored records. Nothing here is projected or estimated.
      </p>

      <section>
        <table>
          <caption className="sr-only">Current totals</caption>
          <thead>
            <tr>
              <th scope="col">Campaigns</th>
              <th scope="col">Strategies</th>
              <th scope="col">Awaiting committee</th>
              <th scope="col">Pending verification</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{summary.campaigns.total}</td>
              <td>{summary.strategies.total}</td>
              <td>{awaitingCommittee}</td>
              <td>{summary.verifications.pending}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Strategy funnel</h2>
        <p className="subtitle">
          Counted by version, not strategy: a strategy has no state of its own, and its versions can
          sit at different stages.
        </p>
        <Funnel funnel={summary.funnel} />
      </section>

      <section>
        <h2>Jobs</h2>
        <Queues queues={summary.queues} />
      </section>

      <section>
        <h2>Recent decisions</h2>
        {summary.decisions.recent.length === 0 ? (
          <div className="empty">
            <p>No decision has been recorded.</p>
            <p>
              A version reaches the committee only after validation produces a parity report and a
              metric snapshot. Until then there is nothing to decide on, so an empty list here is
              the correct state rather than a gap.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Rationale</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {summary.decisions.recent.map((decision) => (
                <tr key={decision.id}>
                  <td>
                    <span className="badge">{decision.outcome}</span>
                  </td>
                  <td>{decision.rationale}</td>
                  <td>
                    <time dateTime={decision.createdAt}>
                      {new Date(decision.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Data and parse failures</h2>
        {summary.parseFailures.recent.length === 0 ? (
          <p className="subtitle">No parse failures recorded.</p>
        ) : (
          // Surfaced prominently: a failed parse nobody sees is
          // indistinguishable from an upload that never happened.
          <div className="error-panel" role="alert">
            <table>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Detail</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {summary.parseFailures.recent.map((failure) => (
                  <tr key={failure.id}>
                    <td>{String(failure.payload['code'] ?? 'unknown')}</td>
                    <td>{String(failure.payload['detail'] ?? '')}</td>
                    <td>
                      <time dateTime={failure.createdAt}>
                        {new Date(failure.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="subtitle">
        Generated{' '}
        <time dateTime={summary.generatedAt}>
          {new Date(summary.generatedAt).toISOString().slice(0, 19).replace('T', ' ')} UTC
        </time>
      </p>
    </>
  );
}
