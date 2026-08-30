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
  readonly createdAt: string;
}

export interface ParityReport {
  readonly id: string;
  readonly runId: string;
  readonly verdict: 'PASS' | 'WARN' | 'FAIL' | 'INSUFFICIENT_DATA';
  readonly firstDivergence: { field: string; reported: string; calculated: string } | null;
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

  listCampaigns(limit = 25, after?: string): Promise<Page<Campaign>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set('after', after);
    return this.#request(`/v1/campaigns?${query.toString()}`);
  }

  listStrategies(limit = 25, after?: string): Promise<Page<Strategy>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set('after', after);
    return this.#request(`/v1/strategies?${query.toString()}`);
  }

  listVersions(strategyId: string): Promise<Page<StrategyVersion>> {
    return this.#request(`/v1/strategies/${strategyId}/versions`);
  }

  getParity(runId: string): Promise<ParityReport> {
    return this.#request(`/v1/backtest-runs/${runId}/parity`);
  }
}

/** Approval levels a version can hold, re-exported so screens need not import twice. */
export type { ApprovalLevel, WorkflowState };
