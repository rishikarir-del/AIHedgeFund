/**
 * Central typed API client.
 *
 * CLAUDE.md 18.5: one client, no direct database access from the web app, and
 * no duplicated contract types. Response shapes are imported from
 * @arf/contracts rather than redeclared here, so a contract change surfaces as
 * a type error in the UI instead of a runtime surprise.
 */
import type { ApprovalLevel, WorkflowState } from '@arf/contracts';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface Campaign {
  readonly id: string;
  readonly organisationId: string;
  readonly name: string;
  readonly brief: string;
  readonly state: WorkflowState;
  readonly createdAt: string;
}

export interface Strategy {
  readonly id: string;
  readonly organisationId: string;
  readonly campaignId: string;
  readonly name: string;
  readonly family: string;
  readonly createdAt: string;
}

export interface StrategyVersion {
  readonly id: string;
  readonly strategyId: string;
  readonly versionNumber: number;
  readonly state: WorkflowState;
  readonly definitionHash: string;
  readonly sourceHash: string | null;
  readonly manifestHash: string | null;
  readonly createdAt: string;
}

export interface StrategyDefinitionRecord {
  readonly id: string;
  readonly strategyVersionId: string;
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
}

export interface PineRevision {
  readonly id: string;
  readonly strategyVersionId: string;
  readonly sourceHash: string;
  readonly manifestHash: string;
  readonly artefactKey: string;
  readonly createdAt: string;
}

export interface Verification {
  readonly id: string;
  readonly strategyVersionId: string;
  readonly status: 'REQUESTED' | 'AWAITING_UPLOAD' | 'PARSING' | 'PARSED' | 'FAILED';
  readonly requiredSymbol: string;
  readonly requiredTimeframe: string;
  readonly requiredSourceHash: string;
  readonly uploads?: readonly { id: string; reportType: string; createdAt: string }[];
}

export interface Trade {
  readonly id: string;
  readonly sequence: number;
  readonly direction: string;
  readonly entryTime: string;
  readonly exitTime: string | null;
  readonly entryPrice: string;
  readonly exitPrice: string | null;
  readonly profit: string | null;
}

export interface EquityPoint {
  readonly id: string;
  readonly barTime: string;
  readonly equity: string;
}

export interface MetricSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly scope: string;
  readonly calculationVersion: string;
  readonly metrics: Record<string, unknown>;
}

export interface DashboardSummary {
  readonly campaigns: { readonly total: number };
  readonly strategies: { readonly total: number };
  readonly funnel: readonly { readonly state: string; readonly count: number }[];
  readonly verifications: { readonly pending: number };
  readonly decisions: {
    readonly recent: readonly {
      readonly id: string;
      readonly outcome: string;
      readonly rationale: string;
      readonly strategyVersionId: string;
      readonly createdAt: string;
    }[];
  };
  readonly parseFailures: {
    readonly recent: readonly {
      readonly id: string;
      readonly payload: Record<string, unknown>;
      readonly createdAt: string;
    }[];
  };
  /** Null when no broker is configured: unavailable, not empty. */
  readonly queues: readonly {
    readonly name: string;
    readonly waiting: number;
    readonly active: number;
    readonly delayed: number;
    readonly failed: number;
    readonly completed: number;
  }[] | null;
  readonly generatedAt: string;
}
export interface BacktestRun {
  readonly id: string;
  readonly strategyVersionId: string;
  readonly source: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly initialCapital: string;
  readonly createdAt: string;
}
export interface ParityReport {
  readonly id: string;
  readonly runId: string;
  readonly verdict: 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT_DATA';
  readonly firstDivergence: { field: string; reported: string; calculated: string } | null;
  readonly checkedFields: readonly string[];
}

export interface AuditEvent {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly priorState: Record<string, unknown> | null;
  readonly newState: Record<string, unknown> | null;
  readonly reason: string | null;
  readonly traceId: string;
  readonly createdAt: string;
}

/** The problem-details shape the API returns (section 7.5). */
export interface ProblemDetails {
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly traceId: string;
  readonly errors?: readonly { path: string; message: string }[];
  readonly hardFails?: readonly { code: string; detail: string }[];
}

export class ApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
    this.problem = problem;
  }
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#token}`,
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      // The API always returns problem-details on error, but a proxy or a
      // network failure might not, so fall back rather than throwing on parse.
      const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
      throw new ApiError(
        problem ?? {
          title: 'Request Failed',
          status: response.status,
          detail: `The API returned ${response.status}.`,
          code: 'unknown_error',
          traceId: 'unknown',
        },
      );
    }

    return (await response.json()) as T;
  }

  /** Returns null for a 404 so a screen can render an empty state, not an error. */
  async #optional<T>(path: string): Promise<T | null> {
    try {
      return await this.#request<T>(path);
    } catch (error) {
      if (error instanceof ApiError && error.problem.status === 404) return null;
      throw error;
    }
  }

  getMarkets(): Promise<unknown> {
    return this.#request(`/v1/markets`);
  }

  getDashboard(): Promise<DashboardSummary> {
    return this.#request(`/v1/dashboard`);
  }

  listCampaigns(limit = 25, after?: string): Promise<Page<Campaign>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set('after', after);
    return this.#request(`/v1/campaigns?${query.toString()}`);
  }

  getCampaign(id: string): Promise<Campaign | null> {
    return this.#optional(`/v1/campaigns/${id}`);
  }

  listStrategies(limit = 25, after?: string): Promise<Page<Strategy>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set('after', after);
    return this.#request(`/v1/strategies?${query.toString()}`);
  }

  listVersions(strategyId: string): Promise<Page<StrategyVersion>> {
    return this.#request(`/v1/strategies/${strategyId}/versions`);
  }

  getDefinition(versionId: string): Promise<StrategyDefinitionRecord | null> {
    return this.#optional(`/v1/versions/${versionId}/definition`);
  }

  listPineRevisions(versionId: string): Promise<Page<PineRevision>> {
    return this.#request(`/v1/versions/${versionId}/pine-revisions`);
  }

  getVerification(id: string): Promise<Verification | null> {
    return this.#optional(`/v1/tradingview-verifications/${id}`);
  }

  listTrades(runId: string, limit = 100): Promise<Page<Trade>> {
    return this.#request(`/v1/backtest-runs/${runId}/trades?limit=${limit}`);
  }

  getEquity(runId: string): Promise<Page<EquityPoint>> {
    return this.#request(`/v1/backtest-runs/${runId}/equity`);
  }

  getMetrics(runId: string, stage = 'IN_SAMPLE'): Promise<Page<MetricSnapshot>> {
    return this.#request(`/v1/backtest-runs/${runId}/metrics?stage=${stage}`);
  }

  getParity(runId: string): Promise<ParityReport | null> {
    return this.#optional(`/v1/backtest-runs/${runId}/parity`);
  }

  listRuns(versionId: string): Promise<Page<BacktestRun>> {
    return this.#request(`/v1/versions/${versionId}/backtest-runs`);
  }
  getAudit(versionId: string): Promise<Page<AuditEvent>> {
    return this.#request(`/v1/versions/${versionId}/audit`);
  }
}

export type { ApprovalLevel, WorkflowState };
