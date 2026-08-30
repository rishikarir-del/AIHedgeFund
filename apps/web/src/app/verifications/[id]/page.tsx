/**
 * Verification Upload.
 *
 * The build prompt requires this screen to state the exact strategy version,
 * Pine hash, symbol, timeframe, settings and report types the uploader must
 * reproduce. Those are shown before any upload control, because an upload made
 * against the wrong settings produces evidence that looks valid and is not.
 */
import { notFound } from 'next/navigation';
import { serverApiClient } from '../../../lib/server-client';
import { UploadPanel } from '../../../components/UploadPanel';

export const dynamic = 'force-dynamic';

export default async function VerificationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = serverApiClient();

  const verification = await client.getVerification(id);
  if (!verification) notFound();

  const apiBaseUrl = process.env['ARF_API_PUBLIC_URL'] ?? 'http://127.0.0.1:3001';
  const uploaded = new Set((verification.uploads ?? []).map((u) => u.reportType));

  return (
    <>
      <h1>TradingView verification</h1>
      <p className="subtitle">
        <span className="badge">{verification.status}</span>
      </p>

      <section>
        <h2>Reproduce exactly these settings</h2>
        <p className="subtitle">
          The parity comparison begins with identity. A report produced under different settings
          will fail parity rather than silently disagree.
        </p>
        <table>
          <tbody>
            <tr>
              <th scope="row">Strategy version</th>
              <td className="trace">{verification.strategyVersionId}</td>
            </tr>
            <tr>
              <th scope="row">Symbol</th>
              <td>{verification.requiredSymbol}</td>
            </tr>
            <tr>
              <th scope="row">Timeframe</th>
              <td>{verification.requiredTimeframe}</td>
            </tr>
            <tr>
              <th scope="row">Pine source hash</th>
              <td className="trace">{verification.requiredSourceHash}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Upload both reports</h2>
        <p className="subtitle">
          Files go directly to object storage. The API issues a signed ticket and verifies the
          stored bytes against their checksum; it never receives the file itself.
        </p>

        {(['performance_summary', 'list_of_trades'] as const).map((reportType) =>
          uploaded.has(reportType) ? (
            <div key={reportType} className="state-machine">
              <strong>
                {reportType === 'list_of_trades' ? 'List of Trades' : 'Performance Summary'}
              </strong>
              <p>Already uploaded and verified.</p>
            </div>
          ) : (
            <UploadPanel
              key={reportType}
              verificationId={verification.id}
              reportType={reportType}
              apiBaseUrl={apiBaseUrl}
            />
          ),
        )}
      </section>
    </>
  );
}
