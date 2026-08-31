/**
 * One-off live check against the real MCP engine.
 *
 * Not part of any test suite: a backtest costs a credit, and a suite that
 * spends money every run is a suite people stop running. This exists to prove
 * the adapter works against the service as it actually behaves, rather than
 * against a fixture shaped by the same assumptions as the adapter.
 *
 * The endpoint is read from the local MCP client config so the key is never
 * typed, pasted, or committed. Nothing here prints it.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { McpBacktestRunner } from '../dist/mcp-runner.js';
import { redactEndpoint } from '../dist/redact.js';

const configPath = path.join(homedir(), '.claude.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const endpoint = config?.mcpServers?.['trader-dev']?.url;

if (!endpoint) {
  console.error('No trader-dev endpoint found in the local MCP config.');
  process.exit(1);
}

console.log(`endpoint  ${redactEndpoint(endpoint)}`);

const runner = new McpBacktestRunner({ endpoint });
console.log(`runner    ${JSON.stringify(runner.capabilities())}`);

const PINE = [
  '//@version=6',
  'strategy("Adapter live check", overlay=true, pyramiding=1, process_orders_on_close=true,',
  '     commission_type=strategy.commission.percent, commission_value=0.05,',
  '     initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100,',
  '     margin_long=100, margin_short=100)',
  'fast = ta.ema(close, 20)',
  'slow = ta.ema(close, 50)',
  'if ta.crossover(fast, slow)',
  '    strategy.entry("L", strategy.long)',
  'if ta.crossunder(fast, slow)',
  '    strategy.close("L")',
].join('\n');

try {
  const result = await runner.run({
    pineSource: PINE,
    symbol: 'BTCUSDT',
    timeframe: '4h',
    from: '2024-06-01',
    to: '2024-09-01',
    initialCapital: '10000',
    notes: 'backtest-sdk adapter live verification',
  });

  console.log('');
  console.log(`runnerName        ${result.runnerName}`);
  console.log(`runnerVersion     ${result.runnerVersion}`);
  console.log(`externalResultId  ${result.externalResultId}`);
  console.log(`durationMs        ${result.durationMs}`);
  console.log(`codeHash          ${result.codeHash.slice(0, 16)}...`);
  console.log(`datasetHash       ${result.datasetHash.slice(0, 16)}...`);
  console.log('');
  console.log(`reported netProfit   ${result.reportedMetrics.netProfit}`);
  console.log(`reported totalTrades ${result.reportedMetrics.totalTrades}`);
  console.log(`reported maxRunup    ${result.reportedMetrics.maxRunup}`);
  console.log('');
  console.log(`trades mapped     ${result.trades.length}`);
  console.log(`equity mapped     ${result.equity.length}`);
  console.log(`warnings          ${result.warnings.length}`);
  for (const warning of result.warnings) console.log(`  - ${warning}`);
} catch (error) {
  console.error(`live check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
