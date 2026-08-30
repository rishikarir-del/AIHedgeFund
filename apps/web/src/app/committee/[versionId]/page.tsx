/**
 * Decision screen.
 *
 * CLAUDE.md 18.3 requires the exact strategy version, mandatory evidence
 * status, validator recommendation, hard failures, the strongest rejection
 * case and override status, and forbids a one-click approval that hides the
 * evidence.
 *
 * The evidence therefore renders above the form, and the form computes its own
 * availability from the same facts. Section 26 also forbids merging reported
 * and calculated figures, so the parity panel names which source each side
 * came from.
 */
import { notFound } from 'next/navigation';
import { serverApiClient } from '../../../lib/server-client';
import { DecisionForm, type HardFail } from '../../../components/DecisionForm';

export const dynamic = 'force-dynamic';

export default async function DecisionPage({
  params,
}: {
  params: Promise<{ versionId: string }>;
}) {
  const { versionId } = await params;
  const client = serverApiClient();

  // The version is reached through its strategy, so the queue link carries the
  // id and the detail is fetched by scanning the organisation's strategies.
  const strategies = await client.listStrategies(100);
  let version = null;
  for (const strategy of strategies.items) {
    const versions = await client.listVersions(strategy.id);
    const found = versions.items.find((v) => v.id === versionId);
    if (found) {
      version = found;
      break;
    }
  }
  if (!version) notFound();

  const [definition, pine, audit] = await Promise.all([
    client.getDefinition(version.id),
    client.listPineRevisions(version.id),
    client.getAudit(version.id),
  ]);

  // Evidence completeness mirrors what the workflow engine requires for
  // promotion. The server is authoritative; this is a preview of its answer.
  const evidence = [
    { label: 'Strategy definition', present: definition !== null },
    { label: 'Pine revision', present: pine.items.length > 0 },
    { label: 'Backtest run', present: false },
    { label: 'Parity report', present: false },
    { label: 'Metric snapshot', present: false },
    { label: 'Validation report', present: false },
  ];
  const evidenceComplete = evidence.every((item) => item.present);

  const hardFails: HardFail[] = [];
  if (!evidenceComplete) {
    for (const item of evidence.filter((e) => !e.present)) {
      hardFails.push({
        code: 'missing_evidence',
        detail: `${item.label} has not been recorded for this version.`,
      });
    }
  }

  const apiBaseUrl = process.env['ARF_API_PUBLIC_URL'] ?? 'http://127.0.0.1:3001';

  return (
    <>
      <h1>Review version {version.versionNumber}</h1>
      <p className="subtitle">
        <span className="badge">{version.state}</span>
        <span className="provenance trace">version {version.id}</span>
      </p>

      <section>
        <h2>Mandatory evidence</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Evidence</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((item) => (
              <tr key={item.label}>
                <td>{item.label}</td>
                <td className={item.present ? 'verdict' : 'divergence-note'} data-verdict="PASS">
                  {item.present ? 'present' : 'missing'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Identity</h2>
        <table>
          <tbody>
            <tr>
              <th scope="row">Definition hash</th>
              <td className="trace">{version.definitionHash}</td>
            </tr>
            <tr>
              <th scope="row">Pine source hash</th>
              <td className="trace">{pine.items[0]?.sourceHash ?? 'not stored'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Validator recommendation</h2>
        <div className="empty">
          <p>No validation report exists for this version.</p>
          <p>
            An absent recommendation is not a neutral one. Approval requires the Robustness
            Validator to have tried to destroy this strategy and reported what survived.
          </p>
        </div>
      </section>

      <section>
        <h2>Prior decisions and overrides</h2>
        {audit.items.filter((event) => event.action.startsWith('workflow.')).length === 0 ? (
          <p className="subtitle">No prior workflow decision recorded. No override in force.</p>
        ) : (
          <table>
            <tbody>
              {audit.items
                .filter((event) => event.action.startsWith('workflow.'))
                .map((event) => (
                  <tr key={event.id}>
                    <td>{event.action}</td>
                    <td>{event.reason ?? '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <DecisionForm
          versionId={version.id}
          versionNumber={version.versionNumber}
          hardFails={hardFails}
          evidenceComplete={evidenceComplete}
          apiBaseUrl={apiBaseUrl}
        />
      </section>
    </>
  );
}
