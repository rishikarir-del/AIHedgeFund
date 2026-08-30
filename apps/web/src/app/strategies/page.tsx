/**
 * Strategy Library.
 *
 * A server component: CLAUDE.md 18.5 puts stable read views on the server so
 * the API token never reaches the browser. Loading and error states live in
 * sibling loading.tsx and error.tsx files, which Next renders automatically --
 * 18.4 requires loading, empty, stale and error states to exist rather than
 * being an afterthought.
 */
import { serverApiClient } from '../../lib/server-client';
import type { Strategy } from '../../lib/api-client';

export const dynamic = 'force-dynamic';

function EmptyState() {
  return (
    <div className="empty">
      <p>No strategies yet.</p>
      <p>
        A strategy appears here once a campaign produces an idea and an architect turns it into a
        definition. Nothing is seeded, because a library of fabricated strategies would be worse
        than an empty one.
      </p>
    </div>
  );
}

export default async function StrategyLibraryPage() {
  const client = serverApiClient();
  const page = await client.listStrategies(50);

  return (
    <>
      <h1>Strategy Library</h1>
      <p className="subtitle">
        Every strategy in this organisation. Figures are historical and simulated.
      </p>

      {page.items.length === 0 ? (
        <EmptyState />
      ) : (
        <table>
          <caption className="sr-only">Strategies with their family and creation date</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Family</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((strategy: Strategy) => (
              <tr key={strategy.id}>
                <td>
                  <a href={`/strategies/${strategy.id}`}>{strategy.name}</a>
                </td>
                <td>{strategy.family}</td>
                <td>
                  {/* UTC, explicitly. Section 7.3 forbids relying on local time. */}
                  <time dateTime={strategy.createdAt}>
                    {new Date(strategy.createdAt).toISOString().slice(0, 10)}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
