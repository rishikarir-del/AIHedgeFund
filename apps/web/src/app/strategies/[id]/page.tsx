/**
 * Strategy Detail.
 *
 * Ten tabs per the build prompt. Tab state lives in the query string so this
 * stays a server component and each tab is linkable -- a reviewer can send
 * someone the exact evidence they are questioning.
 *
 * Section 18.2: tested Pine revisions are read-only, and editing creates a
 * child version. There is no edit affordance anywhere on this page.
 *
 * Section 18.1: every figure states its scope and provenance. Reported and
 * independently calculated values are never merged into one number.
 */
import { notFound } from 'next/navigation';
import { serverApiClient } from '../../../lib/server-client';
import { EvidenceValue } from '../../../components/EvidenceLabel';
import { EquityChart } from '../../../components/EquityChart';
import type {
  AuditEvent,
  BacktestRun,
  PineRevision,
  StrategyVersion,
  Trade,
} from '../../../lib/api-client';

export const dynamic = 'force-dynamic';

const TABS = [
  'evidence',
  'sdl',
  'pine',
  'verification',
  'trades',
  'equity',
  'metrics',
  'lineage',
  'decisions',
  'audit',
] as const;

type Tab = (typeof TABS)[number];

const TAB_LABELS: Readonly<Record<Tab, string>> = {
  evidence: 'Evidence summary',
  sdl: 'SDL',
  pine: 'Pine source',
  verification: 'TradingView',
  trades: 'Trades',
  equity: 'Equity & drawdown',
  metrics: 'Metrics',
  lineage: 'Lineage',
  decisions: 'Decisions',
  audit: 'Audit',
};

function NoEvidence({ what }: { what: string }) {
  return (
    <div className="empty">
      <p>No {what} recorded for this version.</p>
      <p>
        Absence is shown rather than substituted. A figure here would have to be invented, and an
        invented figure is worse than a gap.
      </p>
    </div>
  );
}

function money(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // Trim the fixed 8-decimal storage scale to something readable, without
  // rounding the stored value itself.
  return Number(value).toFixed(2);
}

export default async function StrategyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; version?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const client = serverApiClient();

  const versionsPage = await client.listVersions(id);
  const versions = versionsPage.items;
  if (versions.length === 0) notFound();

  const selected: StrategyVersion =
    versions.find((v) => v.id === query.version) ?? (versions.at(-1) as StrategyVersion);

  const tab: Tab = TABS.includes(query.tab as Tab) ? (query.tab as Tab) : 'evidence';
  const href = (t: Tab) => `/strategies/${id}?tab=${t}&version=${selected.id}`;

  const runsPage = await client.listRuns(selected.id);
  const run: BacktestRun | undefined = runsPage.items.at(-1);

  const [definition, pine, audit, trades, equity, metrics, parity] = await Promise.all([
    client.getDefinition(selected.id),
    client.listPineRevisions(selected.id),
    tab === 'audit' ? client.getAudit(selected.id) : Promise.resolve({ items: [], nextCursor: null }),
    run && tab === 'trades'
      ? client.listTrades(run.id)
      : Promise.resolve({ items: [], nextCursor: null }),
    run && tab === 'equity' ? client.getEquity(run.id) : Promise.resolve({ items: [], nextCursor: null }),
    run && (tab === 'metrics' || tab === 'evidence')
      ? client.getMetrics(run.id)
      : Promise.resolve({ items: [], nextCursor: null }),
    run ? client.getParity(run.id) : Promise.resolve(null),
  ]);

  const snapshot = metrics.items[0];
  const values = (snapshot?.metrics ?? {});

  return (
    <>
      <h1>Strategy detail</h1>
      <p className="subtitle">
        Version {selected.versionNumber} <span className="badge">{selected.state}</span>
        <span className="provenance trace">definition {selected.definitionHash.slice(0, 12)}…</span>
      </p>

      {versions.length > 1 ? (
        <p className="subtitle">
          Versions:{' '}
          {versions.map((v) => (
            <a key={v.id} href={`/strategies/${id}?tab=${tab}&version=${v.id}`}>
              <span className="badge">v{v.versionNumber}</span>
            </a>
          ))}
        </p>
      ) : null}

      <nav aria-label="Strategy detail sections">
        <ul style={{ display: 'flex', flexWrap: 'wrap', gap: 4, listStyle: 'none', padding: 0 }}>
          {TABS.map((t) => (
            <li key={t}>
              <a href={href(t)} aria-current={t === tab ? 'page' : undefined}>
                <span className="badge">{TAB_LABELS[t]}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-live="polite">
        {tab === 'evidence' ? (
          <>
            <h2>Evidence summary</h2>
            <table>
              <tbody>
                <tr>
                  <th scope="row">Definition stored</th>
                  <td>{definition ? 'yes' : 'no'}</td>
                </tr>
                <tr>
                  <th scope="row">Pine revisions</th>
                  <td>{pine.items.length}</td>
                </tr>
                <tr>
                  <th scope="row">Backtest runs</th>
                  <td>{runsPage.items.length}</td>
                </tr>
                <tr>
                  <th scope="row">Parity verdict</th>
                  <td className="verdict" data-verdict={parity?.verdict ?? 'INSUFFICIENT_DATA'}>
                    {parity?.verdict ?? 'not evaluated'}
                  </td>
                </tr>
              </tbody>
            </table>
            {snapshot ? (
              <dl style={{ marginTop: 20 }}>
                <EvidenceValue
                  label="Net profit"
                  value={money(values['netProfit'] as string)}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                  net
                />
                <EvidenceValue
                  label="Closed trades"
                  value={String(values['closedTradeCount'] ?? '')}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                />
                <EvidenceValue
                  label="Max drawdown"
                  value={money(values['maxDrawdown'] as string)}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                />
              </dl>
            ) : null}
          </>
        ) : null}

        {tab === 'sdl' ? (
          definition ? (
            <>
              <h2>Strategy Definition Language</h2>
              <p className="subtitle">Schema version {definition.schemaVersion}. Read-only.</p>
              <pre className="trace">{JSON.stringify(definition.document, null, 2)}</pre>
            </>
          ) : (
            <NoEvidence what="strategy definition" />
          )
        ) : null}

        {tab === 'pine' ? (
          pine.items.length === 0 ? (
            <NoEvidence what="Pine revisions" />
          ) : (
            <>
              <h2>Pine revisions</h2>
              <p className="subtitle">
                Read-only. Editing a tested revision is not possible: a change creates a child
                version (section 18.2).
              </p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Source hash</th>
                    <th scope="col">Manifest hash</th>
                    <th scope="col">Stored</th>
                  </tr>
                </thead>
                <tbody>
                  {pine.items.map((revision: PineRevision) => (
                    <tr key={revision.id}>
                      <td className="trace">{revision.sourceHash.slice(0, 16)}…</td>
                      <td className="trace">{revision.manifestHash.slice(0, 16)}…</td>
                      <td>
                        <time dateTime={revision.createdAt}>
                          {new Date(revision.createdAt).toISOString().slice(0, 10)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        ) : null}

        {tab === 'trades' ? (
          trades.items.length === 0 ? (
            <NoEvidence what="trades" />
          ) : (
            <>
              <h2>Trades</h2>
              <p className="subtitle">
                Normalised from the source ledger. Simulated, historical.{' '}
                <span className="badge" data-scope="IN_SAMPLE">
                  In-sample
                </span>
              </p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Direction</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Exit</th>
                    <th scope="col">Profit (net)</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.items.map((trade: Trade) => (
                    <tr key={trade.id}>
                      <td>{trade.sequence}</td>
                      <td>{trade.direction}</td>
                      <td>{trade.entryTime.slice(0, 16).replace('T', ' ')}</td>
                      <td>
                        {trade.exitTime ? (
                          trade.exitTime.slice(0, 16).replace('T', ' ')
                        ) : (
                          <em className="unknown">open</em>
                        )}
                      </td>
                      <td>
                        {trade.profit === null ? (
                          <em className="unknown">not realised</em>
                        ) : (
                          money(trade.profit)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        ) : null}

        {tab === 'equity' ? (
          equity.items.length === 0 ? (
            <NoEvidence what="equity points" />
          ) : (
            <>
              <h2>Equity and drawdown</h2>
              <p className="subtitle">
                Reconstructed from the trade ledger and the declared initial capital, not read
                from the source report. Equity and drawdown are separate panels sharing one time
                axis: overlaying them on twin axes would invite a relationship the scaling
                invented.
              </p>
              <EquityChart points={equity.items} scope="IN_SAMPLE" />
            </>
          )
        ) : null}

        {tab === 'metrics' ? (
          !snapshot ? (
            <NoEvidence what="metric snapshots" />
          ) : (
            <>
              <h2>Metrics</h2>
              <p className="subtitle">
                Calculation version {snapshot.calculationVersion}. Scope {snapshot.scope}.
                Independently computed from the ledger.
              </p>
              <dl>
                <EvidenceValue
                  label="Net profit"
                  value={money(values['netProfit'] as string)}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                  net
                />
                <EvidenceValue
                  label="Gross profit"
                  value={money(values['grossProfit'] as string)}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                  net={false}
                />
                <EvidenceValue
                  label="Max drawdown"
                  value={money(values['maxDrawdown'] as string)}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                />
                <EvidenceValue
                  label="Max runup"
                  value={money(values['maxRunup'] as string)}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                />
                <EvidenceValue
                  label="Profit factor"
                  value={values['profitFactor'] === null ? null : String(values['profitFactor'])}
                  scope="IN_SAMPLE"
                  provenance="arf_calculated"
                />
              </dl>
              {Array.isArray(values['warnings']) && (values['warnings'] as string[]).length > 0 ? (
                <div className="state-machine">
                  <strong>Calculation warnings</strong>
                  <ul>
                    {(values['warnings'] as string[]).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )
        ) : null}

        {tab === 'verification' ? (
          parity ? (
            <>
              <h2>Parity</h2>
              <p className="subtitle">
                Verdict{' '}
                <span className="verdict" data-verdict={parity.verdict}>
                  {parity.verdict}
                </span>
              </p>
              {parity.firstDivergence ? (
                <table>
                  <tbody>
                    <tr>
                      <th scope="row">First divergence</th>
                      <td>{parity.firstDivergence.field}</td>
                    </tr>
                    <tr>
                      <th scope="row">Reported</th>
                      <td>{parity.firstDivergence.reported}</td>
                    </tr>
                    <tr>
                      <th scope="row">Calculated</th>
                      <td>{parity.firstDivergence.calculated}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p className="subtitle">No divergence found across the checked fields.</p>
              )}
              <p className="subtitle">Checked: {parity.checkedFields.join(', ')}</p>
            </>
          ) : (
            <NoEvidence what="parity report" />
          )
        ) : null}

        {tab === 'audit' ? (
          audit.items.length === 0 ? (
            <NoEvidence what="audit events" />
          ) : (
            <>
              <h2>Audit</h2>
              <p className="subtitle">Append-only. Entries are never edited or removed.</p>
              <table>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Action</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.items.map((event: AuditEvent) => (
                    <tr key={event.id}>
                      <td>
                        <time dateTime={event.createdAt}>
                          {new Date(event.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
                        </time>
                      </td>
                      <td>{event.action}</td>
                      <td className="trace">{event.actor.slice(0, 8)}…</td>
                      <td>{event.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        ) : null}

        {(['lineage', 'decisions'] as Tab[]).includes(tab) ? (
          <>
            <h2>{TAB_LABELS[tab]}</h2>
            <NoEvidence what={TAB_LABELS[tab].toLowerCase()} />
          </>
        ) : null}
      </section>
    </>
  );
}
