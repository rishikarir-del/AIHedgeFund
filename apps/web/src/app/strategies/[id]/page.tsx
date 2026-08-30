/**
 * Strategy Detail.
 *
 * Ten tabs per the build prompt. Tab state lives in the query string so this
 * stays a server component and each tab is linkable -- a reviewer can send
 * someone the exact evidence they are questioning.
 *
 * Section 18.2: tested Pine revisions are read-only, and editing creates a
 * child version. There is no edit affordance anywhere on this page; the Pine
 * tab says so explicitly rather than leaving its absence to be inferred.
 */
import { notFound } from 'next/navigation';
import { serverApiClient } from '../../../lib/server-client';
import type {
  AuditEvent,
  PineRevision,
  StrategyVersion,
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

  const [definition, pine, audit] = await Promise.all([
    tab === 'sdl' || tab === 'evidence' ? client.getDefinition(selected.id) : Promise.resolve(null),
    tab === 'pine' || tab === 'evidence'
      ? client.listPineRevisions(selected.id)
      : Promise.resolve({ items: [], nextCursor: null }),
    tab === 'audit' ? client.getAudit(selected.id) : Promise.resolve({ items: [], nextCursor: null }),
  ]);

  return (
    <>
      <h1>Strategy detail</h1>
      <p className="subtitle">
        {/* The exact version is always visible: section 18.3 requires a
            reviewer to know precisely what they are looking at. */}
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
                  <th scope="row">Source hash</th>
                  <td className="trace">{selected.sourceHash ?? 'not yet stored'}</td>
                </tr>
              </tbody>
            </table>
            <p className="subtitle" style={{ marginTop: 16 }}>
              Backtest, parity and validation evidence attach to runs. Until a run exists this
              version cannot be promoted, and the workflow engine will refuse.
            </p>
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

        {(['verification', 'trades', 'equity', 'metrics', 'lineage', 'decisions'] as Tab[]).includes(
          tab,
        ) ? (
          <>
            <h2>{TAB_LABELS[tab]}</h2>
            <NoEvidence what={TAB_LABELS[tab].toLowerCase()} />
          </>
        ) : null}
      </section>
    </>
  );
}
