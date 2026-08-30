import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/lib/api-client';

function fakeFetch(response: {
  ok: boolean;
  status: number;
  body: unknown;
}): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PAGE = { items: [{ id: 'a', name: 'One' }], nextCursor: null };

describe('ApiClient', () => {
  it('sends the bearer token and never puts it in the URL', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, body: PAGE });
    const client = new ApiClient({ baseUrl: 'http://api.test', token: 'dev:me', fetchImpl: impl });

    await client.listStrategies(10);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer dev:me');
    // A token in a query string leaks into logs and referrers.
    expect(calls[0]?.url).not.toContain('dev:me');
  });

  it('trims a trailing slash from the base url', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, body: PAGE });
    const client = new ApiClient({ baseUrl: 'http://api.test/', token: 't', fetchImpl: impl });

    await client.listCampaigns(5);

    expect(calls[0]?.url).toContain('http://api.test/v1/campaigns');
    expect(calls[0]?.url).not.toContain('//v1');
  });

  it('passes the cursor through when supplied', async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, body: PAGE });
    const client = new ApiClient({ baseUrl: 'http://api.test', token: 't', fetchImpl: impl });

    await client.listStrategies(10, 'cursor-1');

    expect(calls[0]?.url).toContain('after=cursor-1');
  });

  it('throws ApiError carrying the problem-details body', async () => {
    const problem = {
      title: 'Forbidden',
      status: 403,
      detail: 'Role VIEWER does not hold capability campaign:create.',
      code: 'missing_capability',
      traceId: 'trace-9',
    };
    const { impl } = fakeFetch({ ok: false, status: 403, body: problem });
    const client = new ApiClient({ baseUrl: 'http://api.test', token: 't', fetchImpl: impl });

    await expect(client.listCampaigns()).rejects.toBeInstanceOf(ApiError);
    await client.listCampaigns().catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      if (error instanceof ApiError) {
        expect(error.problem.code).toBe('missing_capability');
        // The trace id is how a user report gets correlated to a server log.
        expect(error.problem.traceId).toBe('trace-9');
      }
    });
  });

  it('surfaces hard failures from a rejected decision', async () => {
    const problem = {
      title: 'Policy Rejected',
      status: 409,
      detail: 'One or more hard-fail checks blocked promotion.',
      code: 'hard_fail',
      traceId: 't',
      hardFails: [
        { code: 'parity_failed', detail: 'Parity comparison failed.' },
        { code: 'insufficient_trades', detail: 'Below the minimum trade count.' },
      ],
    };
    const { impl } = fakeFetch({ ok: false, status: 409, body: problem });
    const client = new ApiClient({ baseUrl: 'http://api.test', token: 't', fetchImpl: impl });

    await client.listCampaigns().catch((error: unknown) => {
      if (error instanceof ApiError) {
        // Section 18.3: the UI must be able to show every hard failure.
        expect(error.problem.hardFails).toHaveLength(2);
      }
    });
  });

  it('falls back when an error body is not problem-details', async () => {
    const impl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://api.test', token: 't', fetchImpl: impl });

    await client.listCampaigns().catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApiError);
      if (error instanceof ApiError) {
        expect(error.problem.status).toBe(502);
        expect(error.problem.code).toBe('unknown_error');
      }
    });
  });
});
