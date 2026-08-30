/**
 * Campaign Detail.
 *
 * The build prompt asks for campaign summary, task/state timeline, strategies
 * and audit. Sections that have no data say so explicitly rather than
 * rendering an empty box, so the reader can tell "nothing happened yet" from
 * "this failed to load".
 */
import { notFound } from 'next/navigation';
import { serverApiClient } from '../../../lib/server-client';
import type { Strategy } from '../../../lib/api-client';

export const dynamic = 'force-dynamic';

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const client = serverApiClient();

  const campaign = await client.getCampaign(id);
  if (!campaign) notFound();

  const strategies = await client.listStrategies(100);
  const inCampaign = strategies.items.filter((s: Strategy) => s.campaignId === id);

  return (
    <>
      <h1>{campaign.name}</h1>
      <p className="subtitle">
        <span className="badge">{campaign.state}</span>
        <span className="provenance">
          Created{' '}
          <time dateTime={campaign.createdAt}>
            {new Date(campaign.createdAt).toISOString().slice(0, 10)}
          </time>
        </span>
      </p>

      <section>
        <h2>Brief</h2>
        <p>{campaign.brief}</p>
      </section>

      <section>
        <h2>Strategies</h2>
        {inCampaign.length === 0 ? (
          <div className="empty">
            <p>No strategies have come out of this campaign yet.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Family</th>
              </tr>
            </thead>
            <tbody>
              {inCampaign.map((strategy) => (
                <tr key={strategy.id}>
                  <td>
                    <a href={`/strategies/${strategy.id}`}>{strategy.name}</a>
                  </td>
                  <td>{strategy.family}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
