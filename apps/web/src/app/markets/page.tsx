/**
 * Markets tested.
 *
 * Every market that has accumulated backtest evidence, with its win rate and
 * whether that evidence clears the promotion gates.
 *
 * The star is NOT a recommendation to invest. It reports one mechanical fact:
 * does the stored evidence satisfy every gate the workflow engine already
 * applies. Section 1.3 puts live approval outside this system entirely, and
 * section 28 asks the platform to make rejecting a weak strategy easier than
 * making it look strong -- a screen that implied "buy this" would invert that.
 */
import { serverApiClient } from '../../lib/server-client';

export const dynamic = 'force-dynamic';

interface Market {
  readonly symbol: string;
  readonly timeframe: string;
  readonly runs: number;
  readonly sources: readonly string[];
  readonly outOfSampleRuns: number;
  readonly outOfSampleProfitable: number;
  readonly closedTrades: number;
  readonly winRatePct: number | null;
  readonly gates: Readonly<Record<string, boolean>>;
  readonly meetsEvidenceBar: boolean;
}

const GATE_LABELS: Readonly<Record<string, string>> = {
  hasOutOfSample: 'Out-of-sample evidence exists',
  majorityOfFoldsProfitable: 'Majority of folds profitable out of sample',
  parityNotFailing: 'No parity failure',
  meetsMinimumTrades: 'At least 100 closed trades',
  hasTradingViewEvidence: 'TradingView-sourced run present',
};

export default async function MarketsPage() {
  const client = serverApiClient();
  const data = (await client.getMarkets()) as {
    items: readonly Market[];
    generatedAt: string;
  };

  const starred = data.items.filter((m) => m.meetsEvidenceBar);

  return (
    <>
      <h1>Markets tested</h1>
      <p className="subtitle">
        Every market with stored backtest evidence. Figures are historical and simulated.
      </p>

      {data.items.length === 0 ? (
        <div className="empty">
          <p>No market has been backtested yet.</p>
        </div>
      ) : (
        <>
          <table>
            <caption className="sr-only">
              Markets with run counts, win rate, out-of-sample fold results and whether evidence
              clears the promotion gates.
            </caption>
            <thead>
              <tr>
                <th scope="col"> </th>
                <th scope="col">Symbol</th>
                <th scope="col">Timeframe</th>
                <th scope="col">Runs</th>
                <th scope="col">Win rate</th>
                <th scope="col">Closed trades</th>
                <th scope="col">Folds profitable (OOS)</th>
                <th scope="col">Evidence bar</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((market) => (
                <tr key={`${market.symbol}-${market.timeframe}`}>
                  <td aria-label={market.meetsEvidenceBar ? 'Clears every gate' : 'Does not clear'}>
                    {market.meetsEvidenceBar ? '★' : '·'}
                  </td>
                  <td>{market.symbol}</td>
                  <td>{market.timeframe}</td>
                  <td>{market.runs}</td>
                  <td>
                    {/* Null is "not calculated", never 0%. */}
                    {market.winRatePct === null ? (
                      <em className="unknown">not calculated</em>
                    ) : (
                      `${market.winRatePct.toFixed(1)}%`
                    )}
                  </td>
                  <td>{market.closedTrades}</td>
                  <td>
                    {market.outOfSampleRuns === 0
                      ? '—'
                      : `${market.outOfSampleProfitable}/${market.outOfSampleRuns}`}
                  </td>
                  <td className={market.meetsEvidenceBar ? undefined : 'divergence-note'}>
                    {market.meetsEvidenceBar ? 'clears' : 'does not clear'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <section>
            <h2>What the star means</h2>
            {starred.length === 0 ? (
              <div className="state-machine">
                <p>
                  <strong>No market carries a star.</strong> Nothing in this organisation has
                  evidence that clears every gate.
                </p>
              </div>
            ) : (
              <p className="subtitle">
                {starred.length} market(s) clear every gate. That is a statement about evidence, not
                about what will happen next.
              </p>
            )}

            <p className="subtitle">A star requires all of the following to hold:</p>
            <table>
              <tbody>
                {Object.entries(GATE_LABELS).map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row" style={{ fontWeight: 400 }}>
                      {label}
                    </th>
                    <td>
                      {data.items.filter((m) => m.gates[key]).length}/{data.items.length} markets
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="error-panel" role="note" style={{ marginTop: 20 }}>
            <p>
              <strong>A star is not a recommendation to invest.</strong> It records that stored
              evidence clears the gates above, on historical simulated data. It is not advice, not a
              prediction, and not authorisation to deploy capital — no part of this system can grant
              that.
            </p>
          </div>
        </>
      )}

      <p className="subtitle">
        Generated{' '}
        <time dateTime={data.generatedAt}>
          {new Date(data.generatedAt).toISOString().slice(0, 19).replace('T', ' ')} UTC
        </time>
      </p>
    </>
  );
}
