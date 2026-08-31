/**
 * Backtest runner interface.
 *
 * CLAUDE.md 13 fixes the shape and the required contents of a result. The
 * hashes matter most: without code, manifest, dataset and environment
 * identity, a result cannot be reproduced and therefore is not evidence
 * (section 3.5).
 *
 * 13 also says "do not normalise away runner-specific warnings. Preserve
 * them." Warnings are carried through verbatim rather than mapped onto a
 * common vocabulary, because a warning that only one runner emits is exactly
 * the warning worth reading.
 */

export interface RunnerCapabilities {
  readonly name: string;
  readonly version: string;
  /** Pine versions this runner can execute. */
  readonly pineVersions: readonly number[];
  readonly supportsParameterSweep: boolean;
  readonly supportsCancel: boolean;
  /** True when the runner claims parity with TradingView's broker emulator. */
  readonly claimsTradingViewParity: boolean;
}

export interface BacktestInput {
  readonly pineSource: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly from: string;
  readonly to: string;
  readonly initialCapital: string;
  readonly parameters?: Readonly<Record<string, number | boolean>>;
  /** Free-text label for this run, e.g. a walk-forward segment name. */
  readonly notes?: string;
}

export interface RunnerTrade {
  readonly sequence: number;
  readonly direction: 'long' | 'short';
  readonly entryTime: string;
  readonly exitTime: string | null;
  readonly entryPrice: string;
  readonly exitPrice: string | null;
  readonly quantity: string;
  readonly profit: string | null;
}

export interface RunnerEquityPoint {
  readonly barTime: string;
  readonly equity: string;
}

export interface BacktestResult {
  readonly runnerName: string;
  readonly runnerVersion: string;
  readonly codeHash: string;
  readonly manifestHash: string;
  readonly datasetHash: string;
  readonly environmentHash: string;
  readonly parameters: Readonly<Record<string, number | boolean>>;
  readonly executionSettings: Readonly<Record<string, unknown>>;
  readonly trades: readonly RunnerTrade[];
  readonly equity: readonly RunnerEquityPoint[];
  /** Exactly what the runner reported. Never merged with calculated values. */
  readonly reportedMetrics: Readonly<Record<string, unknown>>;
  /** Preserved verbatim, per section 13. */
  readonly warnings: readonly string[];
  readonly durationMs: number;
  /** The runner's own identifier, so a result can be looked up at the source. */
  readonly externalResultId: string | null;
}

export interface CompileInput {
  readonly pineSource: string;
}

export type CompileResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export class RunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

export interface BacktestRunner {
  capabilities(): RunnerCapabilities;
  compile(input: CompileInput): Promise<CompileResult>;
  run(input: BacktestInput): Promise<BacktestResult>;
  cancel(externalResultId: string): Promise<void>;
}
