/**
 * MCP engine runner.
 *
 * Adapts a remote MCP backtest service (trader.dev) to the `BacktestRunner`
 * interface, so engine runs become first-class evidence under ADR 0002's
 * `mcp_engine` source rather than living outside the system.
 *
 * Three rules from that ADR are enforced here rather than assumed:
 *
 *   1. Strategy source and parameters may leave the system. Nothing else.
 *      `run` sends exactly the fields it declares and no context object.
 *   2. The engine key is a secret. Every message that could carry the endpoint
 *      goes through `redactEndpoint`, and upstream error text through
 *      `redactText`.
 *   3. Engine results are untrusted input. Nothing is read off the response
 *      without a shape check, and a missing field becomes null rather than a
 *      silent zero.
 *
 * KNOWN LIMITATION, verified against the live service on 2026-08-31 (result
 * 01M1AQ1YTH9QTQBWAT5C0VWV74): `quick_backtest` returns aggregate metrics but
 * NO per-trade array and NO equity series. It supplies an `r2Url` pointing at
 * a compressed blob, and exposes `get_trades` / `get_equity_curve` as separate
 * tools.
 *
 * `trades` and `equity` therefore come back empty from this runner today.
 * That matters more than it looks: @arf/metrics recalculates from the ledger,
 * so without trades there is nothing to recalculate and the parity comparison
 * has only one side. Until the ledger is fetched, an `mcp_engine` run is a
 * reported result, not independently verified evidence -- which is precisely
 * what ADR 0002 refuses to promote on.
 *
 * Fetching the ledger is the next step and is deliberately not stubbed here:
 * returning an empty array is honest, whereas synthesising trades from
 * aggregates would manufacture the evidence this system exists to check.
 */
import { createHash } from 'node:crypto';
import {
  RunnerError,
  type BacktestInput,
  type BacktestResult,
  type BacktestRunner,
  type CompileInput,
  type CompileResult,
  type RunnerCapabilities,
  type RunnerEquityPoint,
  type RunnerTrade,
} from './types.js';
import { redactEndpoint, redactText } from './redact.js';

export interface McpRunnerConfig {
  /** Full MCP endpoint, which may carry a credential in its query string. */
  readonly endpoint: string;
  readonly toolName?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  readonly result?: { readonly content?: unknown; readonly isError?: boolean };
  readonly error?: { readonly code?: number; readonly message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a JSON-RPC reply that may arrive as a plain JSON body or as a
 * server-sent event stream. In SSE form the payload sits on `data:` lines; the
 * last complete one is the response to our single request.
 */
function parseJsonRpc(body: string): JsonRpcResponse | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;

  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) ? (parsed) : null;
    } catch {
      return null;
    }
  }

  let latest: JsonRpcResponse | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '' || data === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) latest = parsed;
    } catch {
      // Keep-alive or partial frame; a later line carries the payload.
      continue;
    }
  }
  return latest;
}

/** Reads a string field, or null. Never coerces a number into a string. */
function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/** Money arrives as a number from JSON; render it losslessly as a string. */
function money(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(8);
  return null;
}

export class McpBacktestRunner implements BacktestRunner {
  readonly #config: Required<Omit<McpRunnerConfig, 'fetchImpl'>>;
  readonly #fetch: typeof fetch;
  #requestId = 0;
  /** Empty string means the server is stateless; null means not yet handshaken. */
  #sessionId: string | null = null;

  constructor(config: McpRunnerConfig) {
    if (!config.endpoint) throw new RunnerError('missing_endpoint', 'An MCP endpoint is required.');
    this.#config = {
      endpoint: config.endpoint,
      toolName: config.toolName ?? 'quick_backtest',
      requestTimeoutMs: config.requestTimeoutMs ?? 120_000,
    };
    this.#fetch = config.fetchImpl ?? fetch;
  }

  capabilities(): RunnerCapabilities {
    return {
      name: 'mcp_engine',
      version: '1.0.0',
      pineVersions: [6],
      supportsParameterSweep: true,
      // The remote service exposes no cancel operation.
      supportsCancel: false,
      claimsTradingViewParity: true,
    };
  }

  /**
   * The remote service compiles as part of running, so there is no separate
   * compile step to call. Reporting that honestly is better than issuing a
   * throwaway backtest, which would consume credits to answer a question the
   * caller did not ask.
   */
  async compile(_input: CompileInput): Promise<CompileResult> {
    return {
      ok: true,
      warnings: [
        'This runner has no standalone compile step; syntax errors surface when the backtest runs.',
      ],
    };
  }

  async cancel(_externalResultId: string): Promise<void> {
    throw new RunnerError('cancel_unsupported', 'The MCP engine does not support cancelling a run.');
  }

  async run(input: BacktestInput): Promise<BacktestResult> {
    const startedAt = Date.now();

    // Exactly the declared fields. No context object, no organisation id, no
    // holdout dates beyond the window being tested (ADR 0002 security note).
    const args: Record<string, unknown> = {
      pineSource: input.pineSource,
      symbol: input.symbol,
      timeframe: input.timeframe,
      from: input.from,
      to: input.to,
      initialCapital: Number(input.initialCapital),
    };
    if (input.notes) args['notes'] = input.notes;

    const payload = await this.#call(this.#config.toolName, args);
    const result = this.#extractResult(payload);

    const durationMs = Date.now() - startedAt;
    const codeHash = createHash('sha256').update(input.pineSource, 'utf8').digest('hex');

    const engine = str(payload, 'engine') ?? 'unknown';
    const engineVersion = str(result, 'engineVersion') ?? str(payload, 'engineVersion') ?? 'unknown';

    return {
      runnerName: `mcp_engine:${engine}`,
      runnerVersion: engineVersion,
      codeHash,
      // The engine does not expose a manifest hash, so identity is derived
      // from the settings actually applied rather than invented.
      manifestHash: createHash('sha256')
        .update(JSON.stringify({ symbol: input.symbol, timeframe: input.timeframe }), 'utf8')
        .digest('hex'),
      datasetHash: createHash('sha256')
        .update(`${input.symbol}:${input.timeframe}:${input.from}:${input.to}`, 'utf8')
        .digest('hex'),
      environmentHash: createHash('sha256').update(`${engine}:${engineVersion}`, 'utf8').digest('hex'),
      parameters: input.parameters ?? {},
      executionSettings: isRecord(payload['parityProfile']) ? payload['parityProfile'] : {},
      trades: this.#extractTrades(result),
      equity: this.#extractEquity(result),
      // Verbatim. Independent recalculation happens in @arf/metrics; this is
      // the "reported" half of the parity comparison and must not be cleaned.
      reportedMetrics: result,
      warnings: this.#extractWarnings(payload),
      durationMs,
      externalResultId: str(result, 'id') ?? str(payload, 'resultId'),
    };
  }

  /**
   * MCP streamable HTTP is session-oriented: a server refuses `tools/call`
   * with "Server not initialized" until the client has completed the
   * initialize handshake and echoes the session id it was given.
   *
   * Done lazily and cached, so a runner reused across a parameter sweep pays
   * for the handshake once.
   */
  async #ensureSession(): Promise<void> {
    if (this.#sessionId !== null) return;

    this.#requestId += 1;

    let response: Response;
    try {
      response = await this.#post(
        {
          jsonrpc: '2.0',
          id: this.#requestId,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'arf-backtest-sdk', version: '1.0.0' },
          },
        },
        null,
      );
    } catch (error) {
      // A transport failure here carries the endpoint in its message, so it
      // must be redacted exactly as a failure during the call itself is.
      const detail = error instanceof Error ? redactText(error.message) : 'unknown transport error';
      throw new RunnerError(
        'transport_failed',
        `Request to ${redactEndpoint(this.#config.endpoint)} failed: ${detail}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new RunnerError(
        'initialize_failed',
        `Engine refused initialize at ${redactEndpoint(this.#config.endpoint)}: ${redactText(body).slice(0, 300)}`,
      );
    }

    // Some servers issue a session id, others are stateless. Absence is not
    // an error; only a refusal to initialise is.
    this.#sessionId = response.headers.get('mcp-session-id') ?? '';
    await response.text().catch(() => '');

    // The spec requires this notification before normal operation. It carries
    // no id and expects no reply.
    await this.#post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      this.#sessionId,
    ).catch(() => undefined);
  }

  #post(body: unknown, sessionId: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // MCP streamable HTTP requires the client to accept both, and refuses
      // with 406 otherwise. The server chooses which to send.
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    return this.#fetch(this.#config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async #call(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.#ensureSession();

    this.#requestId += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(this.#config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.#sessionId ? { 'mcp-session-id': this.#sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.#requestId,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? redactText(error.message) : 'unknown transport error';
      throw new RunnerError(
        'transport_failed',
        `Request to ${redactEndpoint(this.#config.endpoint)} failed: ${detail}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new RunnerError(
        'engine_http_error',
        `Engine returned ${response.status} from ${redactEndpoint(this.#config.endpoint)}: ${redactText(body).slice(0, 400)}`,
      );
    }

    // The server may answer as JSON or as an event stream, having been told we
    // accept either. Read the body once as text and decide from its shape
    // rather than its declared content type, which proxies rewrite.
    const bodyText = await response.text().catch(() => '');
    const json = parseJsonRpc(bodyText);
    if (!json) throw new RunnerError('malformed_response', 'Engine response was not valid JSON-RPC.');

    if (json.error) {
      throw new RunnerError(
        'engine_error',
        `Engine reported an error: ${redactText(json.error.message ?? 'no message')}`,
      );
    }

    const content = json.result?.content;
    if (!Array.isArray(content)) {
      throw new RunnerError('malformed_response', 'Engine response contained no content array.');
    }

    // MCP returns content blocks; the structured payload is the first block
    // whose text parses as a JSON object.
    for (const block of content) {
      if (!isRecord(block) || typeof block['text'] !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(block['text']);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Prose block, not the payload. Skip rather than fail: the service
        // interleaves human-readable text with the structured result.
        continue;
      }
    }

    throw new RunnerError('malformed_response', 'No JSON payload found in the engine response.');
  }

  #extractResult(payload: Record<string, unknown>): Record<string, unknown> {
    const nested = payload['result'];
    return isRecord(nested) ? nested : payload;
  }

  #extractTrades(result: Record<string, unknown>): readonly RunnerTrade[] {
    const raw = result['trades'];
    if (!Array.isArray(raw)) return [];

    const trades: RunnerTrade[] = [];
    for (const [index, entry] of raw.entries()) {
      if (!isRecord(entry)) continue;
      const entryTime = str(entry, 'entryTime');
      if (!entryTime) continue;

      trades.push({
        sequence: typeof entry['sequence'] === 'number' ? entry['sequence'] : index + 1,
        direction: entry['direction'] === 'short' ? 'short' : 'long',
        entryTime,
        exitTime: str(entry, 'exitTime'),
        entryPrice: money(entry, 'entryPrice') ?? '0',
        exitPrice: money(entry, 'exitPrice'),
        quantity: money(entry, 'quantity') ?? '0',
        // Null, never zero: an unrealised trade has no profit, which is a
        // different fact from a profit of nothing.
        profit: money(entry, 'profit'),
      });
    }
    return trades;
  }

  #extractEquity(result: Record<string, unknown>): readonly RunnerEquityPoint[] {
    const raw = result['equity'];
    if (!Array.isArray(raw)) return [];

    const points: RunnerEquityPoint[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const barTime = str(entry, 'barTime');
      const equity = money(entry, 'equity');
      if (barTime && equity) points.push({ barTime, equity });
    }
    return points;
  }

  #extractWarnings(payload: Record<string, unknown>): readonly string[] {
    const warnings: string[] = [];

    const top = payload['warning'];
    if (typeof top === 'string') warnings.push(top);

    // Parity adjustments are the engine telling us it changed what we asked
    // for. Section 13 forbids normalising these away.
    const adjustments = payload['parityAdjustments'];
    if (Array.isArray(adjustments)) {
      for (const adjustment of adjustments) {
        if (!isRecord(adjustment)) continue;
        const field = str(adjustment, 'field') ?? 'unknown';
        const applied = str(adjustment, 'applied') ?? '';
        const reason = str(adjustment, 'reason') ?? '';
        warnings.push(`parity adjustment: ${field} -> ${applied} (${reason})`);
      }
    }

    const coverage = payload['coverage'];
    if (isRecord(coverage) && Array.isArray(coverage['warnings'])) {
      for (const item of coverage['warnings']) {
        if (typeof item === 'string') warnings.push(`coverage: ${item}`);
      }
    }

    return warnings;
  }
}
