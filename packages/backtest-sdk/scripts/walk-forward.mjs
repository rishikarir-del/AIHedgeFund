/**
 * Live walk-forward on a real strategy.
 *
 * Costs one credit per window. The plan is priced and printed before anything
 * runs, and the budget refuses it outright if it exceeds the ceiling.
 *
 * The strategy is the EMA 20/50 stop-and-reverse that returned +19.89% over
 * calendar 2024 when tested on the full period in one go. That single figure
 * is in-sample by construction: the whole year was visible. This asks the
 * question that figure cannot answer -- does it survive on data the parameters
 * never saw?
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { McpBacktestRunner } from '../dist/mcp-runner.js';
import { planWalkForward } from '../dist/segments.js';
import { runWalkForward } from '../dist/segment-runner.js';

const endpoint = JSON.parse(readFileSync(path.join(homedir(), '.claude.json'), 'utf8'))
  ?.mcpServers?.['trader-dev']?.url;
if (!endpoint) {
  console.error('No trader-dev endpoint in the local MCP config.');
  process.exit(1);
}

const PINE = [
  '//@version=6',
  'strategy("EMA 20/50 Crossover", overlay=true, pyramiding=1, process_orders_on_close=true,',
  '     commission_type=strategy.commission.percent, commission_value=0.05,',
  '     initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100,',
  '     margin_long=100, margin_short=100)',
  'fast = ta.ema(close, 20)',
  'slow = ta.ema(close, 50)',
  'if ta.crossover(fast, slow)',
  '    strategy.entry("L", strategy.long)',
  'if ta.crossunder(fast, slow)',
  '    strategy.entry("S", strategy.short)',
].join('\n');

const MAX_RUNS = 20;

const plan = planWalkForward({
  from: '2024-01-01',
  to: '2025-01-01',
  model: 'rolling_walk_forward',
  inSampleDays: 90,
  outOfSampleDays: 30,
  embargoDays: 5,
  warmupDays: 0,
});

console.log(`timeframe  ${process.env.WF_TIMEFRAME ?? '1h'}`);
console.log(`model      ${plan.model}`);
console.log(`folds      ${plan.foldCount}`);
console.log(`runs       ${plan.runCount}  (one credit each, budget ${MAX_RUNS})`);
for (const warning of plan.warnings) console.log(`warning    ${warning}`);
console.log('');

const runner = new McpBacktestRunner({ endpoint });

const report = await runWalkForward(runner, plan, {
  pineSource: PINE,
  symbol: 'BTCUSDT',
  timeframe: process.env.WF_TIMEFRAME ?? '1h',
  initialCapital: '10000',
  maxRuns: MAX_RUNS,
  onProgress: (window, completed, total) => {
    process.stdout.write(
      `  [${String(completed + 1).padStart(2)}/${total}] fold ${window.foldId} ${window.scope.padEnd(14)} ${window.from} -> ${window.to}\n`,
    );
  },
});

console.log('');
console.log('fold  in-sample      out-of-sample  retention  survived');
console.log('----  -------------  -------------  ---------  --------');
for (const fold of report.folds) {
  const is = fold.inSampleNetProfit;
  const oos = fold.outOfSampleNetProfit;
  const ret = fold.retention;
  console.log(
    `${String(fold.foldId).padStart(4)}  ` +
      `${(is === null ? 'n/a' : is.toFixed(2)).padStart(13)}  ` +
      `${(oos === null ? 'n/a' : oos.toFixed(2)).padStart(13)}  ` +
      `${(ret === null ? 'n/a' : `${(ret * 100).toFixed(0)}%`).padStart(9)}  ` +
      `${fold.outOfSampleProfitable === null ? 'n/a' : fold.outOfSampleProfitable ? 'yes' : 'no'}`,
  );
}

const oosTotal = report.folds.reduce((sum, f) => sum + (f.outOfSampleNetProfit ?? 0), 0);
const isTotal = report.folds.reduce((sum, f) => sum + (f.inSampleNetProfit ?? 0), 0);

console.log('');
console.log(`folds completed            ${report.foldsCompleted}/${plan.foldCount}`);
console.log(`folds profitable out-of-sample  ${report.foldsOutOfSampleProfitable}/${report.foldsCompleted}`);
console.log(`summed in-sample net       ${isTotal.toFixed(2)}`);
console.log(`summed out-of-sample net   ${oosTotal.toFixed(2)}`);
console.log(`credits spent              ${report.runsSpent}`);

const notable = report.warnings.filter((w) => !w.includes('parity adjustment'));
if (notable.length > 0) {
  console.log('');
  console.log('warnings:');
  for (const warning of notable) console.log(`  - ${warning}`);
}
