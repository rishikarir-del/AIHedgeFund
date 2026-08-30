import { serverApiClient } from '../../lib/server-client';
import type { Campaign } from '../../lib/api-client';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const client = serverApiClient();
  const page = await client.listCampaigns(50);

  return (
    <>
      <h1>Campaigns</h1>
      <p className="subtitle">Research campaigns in this organisation.</p>

      {page.items.length === 0 ? (
        <div className="empty">
          <p>No campaigns yet.</p>
          <p>A campaign is the unit of research scope: markets, timeframes and a brief.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">State</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((campaign: Campaign) => (
              <tr key={campaign.id}>
                <td>
                  <a href={`/campaigns/${campaign.id}`}>{campaign.name}</a>
                </td>
                <td>
                  <span className="badge">{campaign.state}</span>
                </td>
                <td>
                  <time dateTime={campaign.createdAt}>
                    {new Date(campaign.createdAt).toISOString().slice(0, 10)}
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
