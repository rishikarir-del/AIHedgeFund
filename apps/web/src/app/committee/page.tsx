/**
 * Committee queue.
 *
 * Lists versions awaiting a human decision. Everything else is deliberately
 * excluded: a queue that shows work not needing attention trains people to
 * scroll past the work that does.
 */
import { serverApiClient } from '../../lib/server-client';
import type { Strategy, StrategyVersion } from '../../lib/api-client';

export const dynamic = 'force-dynamic';

const AWAITING = new Set(['PAPER_APPROVAL_REVIEW', 'TRADINGVIEW_VERIFICATION']);

export default async function CommitteePage() {
  const client = serverApiClient();
  const strategies = await client.listStrategies(100);

  const rows: { strategy: Strategy; version: StrategyVersion }[] = [];
  for (const strategy of strategies.items) {
    const versions = await client.listVersions(strategy.id);
    for (const version of versions.items) {
      if (AWAITING.has(version.state)) rows.push({ strategy, version });
    }
  }

  return (
    <>
      <h1>Committee queue</h1>
      <p className="subtitle">Versions awaiting a human decision.</p>

      {rows.length === 0 ? (
        <div className="empty">
          <p>Nothing is waiting on the committee.</p>
          <p>
            A version reaches this queue only after validation produces a parity report and metric
            snapshot. Until then there is nothing to decide on.
          </p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Strategy</th>
              <th scope="col">Version</th>
              <th scope="col">State</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ strategy, version }) => (
              <tr key={version.id}>
                <td>{strategy.name}</td>
                <td>v{version.versionNumber}</td>
                <td>
                  <span className="badge">{version.state}</span>
                </td>
                <td>
                  <a href={`/committee/${version.id}`}>Review</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
