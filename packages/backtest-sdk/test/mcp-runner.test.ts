/**
 * MCP runner tests.
 *
 * Fetch is injected throughout: these must never reach the real service.
 * A backtest costs a credit, and a test suite that spends money on every run
 * is a test suite people stop running.
 *
 * The response fixture is shaped from a real trader.dev reply, including its
 * parity adjustments and the `maxRunup: 0` defect, so the adapter is exercised
 * against what the service actually returns rather than an idealised version.
 */
import { describe, expect, it, vi } from 'vitest';
import { McpBacktestRunner } from '../src/mcp-runner.js';
import { redactEndpoint, redactText } from '../src/redact.js';
import { RunnerError } from '../src/types.js';

const ENDPOINT = 'https://mcp.trader.dev/mcp?key=pk_SuperSecretValue123';

const ENGINE_PAYLOAD = {
  resultId: '01M17XT37S9N50KKMX7DEG8XBJ',
  engine: 'tv_jul26',
  result: {
    id: '01M17XT37S9N50KKMX7DEG8XBJ',
    engineVersion: 'tv_jul26_mc7',
    netProfit: 1988.639774,
    netProfitPct: 19.88639774,
    totalTrades: 204,
    maxDrawdownPct: 35.99947732,
    maxRunup: 0,
    trades: [
      {
        sequence: 1,
        direction: 'long',
        entryTime: '2024-01-03T15:00:00.000Z',
        exitTime: '2024-01-05T09:00:00.000Z',
        entryPrice: 42150.5,
        exitPrice: 43980.1,
        quantity: 0.237,
        profit: 433.62,
      },
      {
        sequence: 2,
        direction: 'long',
        entryTime: '2024-01-10T12:00:00.000Z',
        exitTime: null,
        entryPrice: 44000,
        exitPrice: null,
        quantity: 0.23,
        profit: null,
      },
    ],
    equity: [{ barTime: '2024-01-05T09:00:00.000Z', equity: 10433.62 }],
  },
  parityProfile: { commissionValue: 0.05, sizingType: 'percent_of_equity' },
  parityAdjustments: [
    { field: 'commission', applied: '0.05', reason: 'mcp_parity_profile_commission_0_05' },
  ],
  coverage: { warnings: ['requested window clamped to available history'] },
};

function envelope(payload: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
}

function stubFetch(payload: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({
    headers: new Headers(),
    ok,
    status,
    text: async () => envelope(payload),
  })) as unknown as typeof fetch;
}

const INPUT = {
  pineSource: '//@version=6\nstrategy("T")',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  from: '2024-01-01',
  to: '2025-01-01',
  initialCapital: '10000',
};

describe('redaction (ADR 0002 security note)', () => {
  it('replaces a key in the query string', () => {
    const safe = redactEndpoint(ENDPOINT);
    expect(safe).not.toContain('pk_SuperSecretValue123');
    expect(safe).toContain('REDACTED');
    // The host and path stay, so the message is still diagnostic.
    expect(safe).toContain('mcp.trader.dev/mcp');
  });

  it('refuses to echo an endpoint it cannot parse', () => {
    // Unparseable input may still contain the credential.
    expect(redactEndpoint('key=pk_leaked')).toBe('[unparseable endpoint]');
  });

  it('scrubs secrets from arbitrary upstream text', () => {
    expect(redactText('failed for https://x/y?token=abc123def456')).not.toContain('abc123def456');
    expect(redactText('bad key pk_abcdefgh12345')).not.toContain('pk_abcdefgh12345');
  });
});

describe('McpBacktestRunner.run', () => {
  it('maps trades, preserving a null profit rather than zeroing it', async () => {
    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: stubFetch(ENGINE_PAYLOAD) });
    const result = await runner.run(INPUT);

    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]?.profit).toBe('433.62000000');
    // An open trade has no profit. That is not a profit of nothing.
    expect(result.trades[1]?.profit).toBeNull();
    expect(result.trades[1]?.exitTime).toBeNull();
  });

  it('carries reported metrics through verbatim, defect included', async () => {
    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: stubFetch(ENGINE_PAYLOAD) });
    const result = await runner.run(INPUT);

    // The engine reports maxRunup as 0 on a profitable run, which is wrong.
    // The adapter must not silently correct it: @arf/metrics recalculates
    // independently and the parity report is where the two disagree.
    expect(result.reportedMetrics['maxRunup']).toBe(0);
    expect(result.reportedMetrics['totalTrades']).toBe(204);
  });

  it('preserves parity adjustments and coverage warnings (section 13)', async () => {
    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: stubFetch(ENGINE_PAYLOAD) });
    const result = await runner.run(INPUT);

    expect(result.warnings.some((w) => w.includes('parity adjustment: commission'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('coverage: requested window clamped'))).toBe(true);
  });

  it('produces the four identity hashes a reproducible run needs', async () => {
    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: stubFetch(ENGINE_PAYLOAD) });
    const result = await runner.run(INPUT);

    for (const hash of [
      result.codeHash,
      result.manifestHash,
      result.datasetHash,
      result.environmentHash,
    ]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.externalResultId).toBe('01M17XT37S9N50KKMX7DEG8XBJ');
    expect(result.runnerName).toBe('mcp_engine:tv_jul26');
  });

  it('sends only the declared fields (ADR 0002: nothing else leaves)', async () => {
    const calls: { body: string }[] = [];
    const capturing = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: String(init?.body) });
      return {
        headers: new Headers(),
        ok: true,
        status: 200,
        text: async () => envelope(ENGINE_PAYLOAD),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: capturing });
    await runner.run(INPUT);

    const toolCall = calls
      .map((c) => JSON.parse(c.body) as { method: string; params?: { arguments?: Record<string, unknown> } })
      .find((c) => c.method === 'tools/call');
    expect(toolCall).toBeDefined();
    const sent = toolCall as { params: { arguments: Record<string, unknown> } };
    expect(Object.keys(sent.params.arguments).sort()).toEqual([
      'from',
      'initialCapital',
      'pineSource',
      'symbol',
      'timeframe',
      'to',
    ]);
  });
});

describe('McpBacktestRunner error handling', () => {
  it('never leaks the key in a transport error', async () => {
    const failing = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${ENDPOINT}`);
    }) as unknown as typeof fetch;

    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: failing });
    await expect(runner.run(INPUT)).rejects.toThrow(RunnerError);
    await runner.run(INPUT).catch((error: unknown) => {
      expect(String(error)).not.toContain('pk_SuperSecretValue123');
      expect(String(error)).toContain('REDACTED');
    });
  });

  it('never leaks the key in an upstream error body', async () => {
    const erroring = vi.fn(async () => ({
      headers: new Headers(),
      ok: false,
      status: 401,
      text: async () => `unauthorized for ${ENDPOINT}`,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: erroring });
    await runner.run(INPUT).catch((error: unknown) => {
      expect(String(error)).not.toContain('pk_SuperSecretValue123');
    });
  });

  it('rejects a response with no JSON payload rather than inventing one', async () => {
    const prose = vi.fn(async () => ({
      headers: new Headers(),
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: 'just some prose' }] } }),
    })) as unknown as typeof fetch;

    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: prose });
    await expect(runner.run(INPUT)).rejects.toThrow(/No JSON payload/);
  });

  it('skips prose blocks and finds the payload after them', async () => {
    const mixed = vi.fn(async () => ({
      headers: new Headers(),
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          result: {
            content: [
              { type: 'text', text: 'Strategy Tester tip: match these settings' },
              { type: 'text', text: JSON.stringify(ENGINE_PAYLOAD) },
            ],
          },
        }),
    })) as unknown as typeof fetch;

    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: mixed });
    const result = await runner.run(INPUT);
    expect(result.trades).toHaveLength(2);
  });
});

describe('capabilities', () => {
  it('declares no cancel support rather than pretending', async () => {
    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: stubFetch({}) });
    expect(runner.capabilities().supportsCancel).toBe(false);
    await expect(runner.cancel('x')).rejects.toThrow(/does not support cancelling/);
  });

  it('reports that compile is not a separate step instead of burning a credit', async () => {
    const spent = vi.fn();
    const runner = new McpBacktestRunner({ endpoint: ENDPOINT, fetchImpl: spent });
    const compiled = await runner.compile({ pineSource: '//@version=6' });

    expect(compiled.ok).toBe(true);
    // No network call: a throwaway backtest to answer a compile question
    // would cost a credit the caller never asked to spend.
    expect(spent).not.toHaveBeenCalled();
  });
});
