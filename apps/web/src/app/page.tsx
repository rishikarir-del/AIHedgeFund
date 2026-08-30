/**
 * Command Centre.
 *
 * The build prompt's final instruction warns against a beautiful but
 * ungrounded dashboard, so this shows only counts that come from real records
 * and states plainly when there is nothing to show. No fabricated tiles, no
 * placeholder sparklines.
 */
import { serverApiClient } from '../lib/server-client';

export const dynamic = 'force-dynamic';

export default async function CommandCentrePage() {
  const client = serverApiClient();
  const [campaigns, strategies] = await Promise.all([
    client.listCampaigns(100),
    client.listStrategies(100),
  ]);

  const tiles = [
    { label: 'Campaigns', value: campaigns.items.length },
    { label: 'Strategies', value: strategies.items.length },
  ];

  return (
    <>
      <h1>Command Centre</h1>
      <p className="subtitle">Counts reflect stored records only. Nothing here is projected.</p>

      <table>
        <caption className="sr-only">Current record counts</caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {tiles.map((tile) => (
            <tr key={tile.label}>
              <td>{tile.label}</td>
              <td>{tile.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {campaigns.items.length === 0 && strategies.items.length === 0 ? (
        <div className="empty" style={{ marginTop: 20 }}>
          <p>Nothing recorded yet.</p>
          <p>Create a campaign to begin. The funnel populates from real research, not fixtures.</p>
        </div>
      ) : null}
    </>
  );
}
