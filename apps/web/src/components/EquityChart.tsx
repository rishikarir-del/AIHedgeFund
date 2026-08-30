'use client';

/**
 * Equity and drawdown chart.
 *
 * CLAUDE.md 18.4 requires a dedicated time-series library, linked date
 * brushing, accessible summaries, export, no misleading dual axes, scope and
 * units in the tooltip, and empty/error/stale states.
 *
 * "No misleading dual axes" drives the layout. Equity and drawdown have
 * different units and opposite senses, and overlaying them on twin axes lets
 * the reader infer a relationship from whatever scaling was chosen. They are
 * therefore two stacked panels sharing one x-axis, cursor-synced so moving
 * over either reads both -- which is also what satisfies linked brushing.
 *
 * 18.1 forbids presenting historical and forward equity as one uninterrupted
 * series. Each segment is drawn as its own series with a visible boundary, so
 * a forward segment can never be mistaken for backtest history.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export type SeriesScope = 'IN_SAMPLE' | 'VALIDATION' | 'OUT_OF_SAMPLE' | 'FINAL_HOLDOUT' | 'FORWARD';

export interface EquityDatum {
  readonly barTime: string;
  readonly equity: string;
}

export interface EquityChartProps {
  readonly points: readonly EquityDatum[];
  readonly scope: SeriesScope;
  readonly currency?: string;
  /** True when the underlying run is superseded; renders a stale banner. */
  readonly stale?: boolean;
}

const SCOPE_LABELS: Readonly<Record<SeriesScope, string>> = {
  IN_SAMPLE: 'In-sample',
  VALIDATION: 'Validation',
  OUT_OF_SAMPLE: 'Out-of-sample',
  FINAL_HOLDOUT: 'Final holdout',
  FORWARD: 'Forward (paper)',
};

interface Derived {
  readonly x: number[];
  readonly equity: number[];
  readonly drawdownPct: number[];
  readonly peak: number;
  readonly trough: number;
  readonly maxDrawdownPct: number;
  readonly first: number;
  readonly last: number;
}

/**
 * Drawdown is derived here rather than fetched. It is a pure function of the
 * equity series -- running peak minus current, as a percentage of that peak --
 * so deriving it cannot disagree with the curve being drawn beside it.
 */
function derive(points: readonly EquityDatum[]): Derived | null {
  if (points.length === 0) return null;

  const x: number[] = [];
  const equity: number[] = [];
  const drawdownPct: number[] = [];

  let runningPeak = Number.NEGATIVE_INFINITY;
  let trough = Number.POSITIVE_INFINITY;
  let maxDrawdownPct = 0;

  for (const point of points) {
    const t = Date.parse(point.barTime);
    const value = Number(point.equity);
    if (Number.isNaN(t) || !Number.isFinite(value)) continue;

    runningPeak = Math.max(runningPeak, value);
    trough = Math.min(trough, value);

    const dd = runningPeak === 0 ? 0 : ((runningPeak - value) / runningPeak) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);

    x.push(Math.floor(t / 1000));
    equity.push(value);
    // Plotted negative so a fall reads downward, matching intuition.
    drawdownPct.push(-dd);
  }

  if (x.length === 0) return null;

  return {
    x,
    equity,
    drawdownPct,
    peak: runningPeak,
    trough,
    maxDrawdownPct,
    first: equity[0] as number,
    last: equity.at(-1) as number,
  };
}

function formatMoney(value: number, currency: string): string {
  return `${currency} ${value.toFixed(2)}`;
}

export function EquityChart({
  points,
  scope,
  currency = 'USD',
  stale = false,
}: EquityChartProps): ReactElement {
  const equityRef = useRef<HTMLDivElement | null>(null);
  const drawdownRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const derived = useMemo(() => derive(points), [points]);

  useEffect(() => {
    if (!derived || !equityRef.current || !drawdownRef.current) return;

    const charts: uPlot[] = [];
    try {
      // A shared sync key is what links the two panels: hovering either moves
      // the cursor on both, which is the brushing 18.4 asks for.
      const sync = uPlot.sync('equity-drawdown');

      const common = {
        width: equityRef.current.clientWidth || 720,
        cursor: {
          sync: { key: sync.key, setSeries: true },
          drag: { x: true, y: false, setScale: true },
        },
        legend: { live: true },
      } as const;

      const equityChart = new uPlot(
        {
          ...common,
          height: 220,
          title: `Equity — ${SCOPE_LABELS[scope]} (simulated, net of declared costs)`,
          series: [
            { label: 'Bar time (UTC)' },
            {
              label: `Equity (${currency})`,
              stroke: '#6b8afd',
              width: 2,
              value: (_self, raw) => (raw === null ? '—' : formatMoney(raw, currency)),
            },
          ],
          axes: [
            { stroke: '#8b93a7', grid: { stroke: '#272b35' } },
            { stroke: '#8b93a7', grid: { stroke: '#272b35' } },
          ],
        },
        [derived.x, derived.equity],
        equityRef.current,
      );
      charts.push(equityChart);

      const drawdownChart = new uPlot(
        {
          ...common,
          height: 150,
          title: 'Drawdown from running peak (%)',
          series: [
            { label: 'Bar time (UTC)' },
            {
              label: 'Drawdown (%)',
              stroke: '#d95f5f',
              fill: 'rgba(217, 95, 95, 0.15)',
              width: 1.5,
              value: (_self, raw) => (raw === null ? '—' : `${Math.abs(raw).toFixed(2)} %`),
            },
          ],
          axes: [
            { stroke: '#8b93a7', grid: { stroke: '#272b35' } },
            { stroke: '#8b93a7', grid: { stroke: '#272b35' } },
          ],
        },
        [derived.x, derived.drawdownPct],
        drawdownRef.current,
      );
      charts.push(drawdownChart);

      const onResize = (): void => {
        const width = equityRef.current?.clientWidth ?? 720;
        for (const chart of charts) chart.setSize({ width, height: chart.height });
      };
      window.addEventListener('resize', onResize);

      return () => {
        window.removeEventListener('resize', onResize);
        for (const chart of charts) chart.destroy();
      };
    } catch (error) {
      // A chart that fails must say so rather than leaving a blank panel.
      setFailed(error instanceof Error ? error.message : 'Chart failed to render.');
      for (const chart of charts) chart.destroy();
      return undefined;
    }
  }, [derived, scope, currency]);

  if (points.length === 0) {
    return (
      <div className="empty">
        <p>No equity points recorded for this run.</p>
        <p>The curve is reconstructed from the trade ledger; without trades there is nothing to draw.</p>
      </div>
    );
  }

  if (!derived) {
    return (
      <div className="error-panel" role="alert">
        <p>Equity points exist but none could be parsed into a time series.</p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="error-panel" role="alert">
        <p>The chart could not be rendered: {failed}</p>
        <p>The figures below are unaffected and remain authoritative.</p>
      </div>
    );
  }

  const csv = [
    'bar_time_utc,equity,drawdown_pct',
    ...derived.x.map(
      (t, i) =>
        `${new Date(t * 1000).toISOString()},${derived.equity[i]},${Math.abs(derived.drawdownPct[i] as number).toFixed(6)}`,
    ),
  ].join('\n');

  return (
    <figure style={{ margin: 0 }}>
      {stale ? (
        <p className="divergence-note" role="status">
          This run has been superseded by a newer version. Shown for history only.
        </p>
      ) : null}

      {/* Accessible summary (18.4). Screen readers and anyone who cannot use
          the canvas get the same facts, not a vaguer version of them. */}
      <figcaption className="chart-summary">
        {SCOPE_LABELS[scope]} equity curve over {derived.x.length} points. Starting equity{' '}
        {formatMoney(derived.first, currency)}, ending {formatMoney(derived.last, currency)}. Peak{' '}
        {formatMoney(derived.peak, currency)}, trough {formatMoney(derived.trough, currency)}. Maximum
        drawdown {derived.maxDrawdownPct.toFixed(2)} percent. Simulated historical results.
      </figcaption>

      <div ref={equityRef} role="img" aria-label={`Equity curve, ${SCOPE_LABELS[scope]}`} />
      <div
        ref={drawdownRef}
        role="img"
        aria-label="Drawdown from running peak, percent"
        style={{ marginTop: 8 }}
      />

      <p className="subtitle" style={{ marginTop: 8 }}>
        <span className="badge" data-scope={scope}>
          {SCOPE_LABELS[scope]}
        </span>
        <span className="provenance">ARF calculated · reconstructed from the trade ledger</span>
      </p>

      <p>
        <a
          download={`equity-${scope.toLowerCase()}.csv`}
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}
        >
          Export series as CSV
        </a>
      </p>

      <details>
        <summary>Series summary as a table</summary>
        <table>
          <tbody>
            <tr>
              <th scope="row">Points</th>
              <td>{derived.x.length}</td>
            </tr>
            <tr>
              <th scope="row">Starting equity</th>
              <td>{formatMoney(derived.first, currency)}</td>
            </tr>
            <tr>
              <th scope="row">Ending equity</th>
              <td>{formatMoney(derived.last, currency)}</td>
            </tr>
            <tr>
              <th scope="row">Peak</th>
              <td>{formatMoney(derived.peak, currency)}</td>
            </tr>
            <tr>
              <th scope="row">Maximum drawdown</th>
              <td>{derived.maxDrawdownPct.toFixed(2)} %</td>
            </tr>
          </tbody>
        </table>
      </details>
    </figure>
  );
}
