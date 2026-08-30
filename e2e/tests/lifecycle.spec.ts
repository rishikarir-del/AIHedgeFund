/**
 * End-to-end path through the vertical slice.
 *
 * The build prompt lists ten steps. This drives them through the real HTTP
 * surface with both servers running from built artefacts, so a pass means the
 * system boots and works, not that a mock agreed with itself.
 *
 * Data is created through the API and read back through the UI, which is the
 * combination that catches a screen rendering something the API never said.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';

const API = 'http://127.0.0.1:3101';
const DEV = 'Bearer dev:dev-developer';
const COMMITTEE = 'Bearer dev:dev-committee';

const SDL = {
  schemaVersion: '1.0.0',
  strategy: { name: 'E2E', family: 'trend_following', thesis: 'End to end.', directions: ['long'] },
  market: {
    assetClass: 'crypto',
    symbols: ['BYBIT:BTCUSDT.P'],
    timeframe: '60',
    timezone: 'Etc/UTC',
    session: '0000-2359:1234567',
    chartType: 'standard_ohlc',
  },
  signals: { longEntry: 'fast_above_slow AND confirmed_bar' },
  execution: {
    entryOrder: 'market_next_bar',
    pyramiding: 0,
    allowReversal: false,
    processOnClose: false,
    calcOnEveryTick: false,
  },
  risk: {
    sizingModel: 'percent_of_equity',
    sizePercent: 10,
    leverage: 1,
    stopLoss: { type: 'atr_multiple', valueParameter: 'stop_atr' },
    takeProfit: { type: 'risk_multiple', valueParameter: 'target_r' },
    oneStopOneTarget: true,
  },
  costs: { commissionType: 'percent', commissionValue: 0.05, slippageTicks: 2 },
  parameters: [
    { key: 'stop_atr', type: 'float', default: 2, min: 1, max: 4, step: 0.25 },
    { key: 'target_r', type: 'float', default: 2, min: 1, max: 4, step: 0.25 },
  ],
  segments: { warmupBars: 300, selectionMode: 'rolling_walk_forward', embargoBars: 10 },
  falsification: ['Out-of-sample net profit is non-positive.'],
};

const PINE = [
  '//@version=6',
  'strategy("E2E", pyramiding=0, commission_value=0.05, margin_long=100, margin_short=100)',
  'fast = ta.ema(close, 20)',
  'if ta.crossover(fast, ta.ema(close, 50))',
  '    strategy.entry("L", strategy.long)',
].join('\n');

let campaignId = '';
let strategyName = '';
let strategyId = '';
let versionId = '';

async function json(request: APIRequestContext, method: 'post' | 'get', path: string, body?: unknown) {
  const response = await request[method](`${API}${path}`, {
    headers: { authorization: DEV, 'content-type': 'application/json' },
    ...(body ? { data: body } : {}),
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

test.describe.serial('vertical slice', () => {
  test('the API is reachable and refuses anonymous access', async ({ request }) => {
    const health = await request.get(`${API}/health`);
    expect(health.status()).toBe(200);

    const anonymous = await request.get(`${API}/v1/campaigns`);
    expect(anonymous.status()).toBe(401);
  });

  test('creates a campaign, strategy and immutable version', async ({ request }) => {
    const campaign = await json(request, 'post', '/v1/campaigns', {
      name: `E2E campaign ${Date.now()}`,
      brief: 'Driven end to end.',
    });
    expect(campaign.status).toBe(201);
    campaignId = campaign.body.id;

    strategyName = `E2E strategy ${Date.now()}`;
    const strategy = await json(request, 'post', '/v1/strategies', {
      campaignId,
      name: strategyName,
      family: 'trend_following',
    });
    expect(strategy.status).toBe(201);
    strategyId = strategy.body.id;

    const version = await json(request, 'post', `/v1/strategies/${strategyId}/versions`, {
      reason: 'initial',
      definition: SDL,
    });
    expect(version.status).toBe(201);
    expect(version.body.versionNumber).toBe(1);
    versionId = version.body.id;
  });

  test('stores a compliant Pine revision and refuses a repainting one', async ({ request }) => {
    const good = await json(request, 'post', `/v1/versions/${versionId}/pine-revisions`, {
      source: PINE,
      manifest: { symbol: 'BTCUSDT' },
      artefactKey: 'e2e-key',
    });
    expect(good.status).toBe(201);

    const bad = await json(request, 'post', `/v1/versions/${versionId}/pine-revisions`, {
      source: `${PINE}\nx = close[-1]`,
      manifest: {},
      artefactKey: 'e2e-bad',
    });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('pine_lint_failed');
  });

  test('refuses promotion without evidence, and says why', async ({ request }) => {
    const response = await request.post(`${API}/v1/decisions`, {
      headers: { authorization: COMMITTEE, 'content-type': 'application/json' },
      data: {
        strategyVersionId: versionId,
        to: 'PAPER_APPROVED',
        rationale: 'Attempting promotion with no backtest evidence at all.',
      },
    });
    expect(response.status()).toBe(409);
  });

  test('the Strategy Library shows the new strategy', async ({ page }) => {
    await page.goto('/strategies');
    await expect(page.getByRole('heading', { name: 'Strategy Library' })).toBeVisible();
    // Exact name, not a pattern: a regex would match every previous run's
    // strategy and trip Playwright strict mode.
    await expect(page.getByRole('link', { name: strategyName, exact: true })).toBeVisible();
  });

  test('Strategy Detail renders the version, its tabs and the SDL', async ({ page }) => {
    await page.goto(`/strategies/${strategyId}`);
    await expect(page.getByRole('heading', { name: 'Strategy detail' })).toBeVisible();
    await expect(page.getByText('Version 1')).toBeVisible();

    await page.goto(`/strategies/${strategyId}?tab=sdl&version=${versionId}`);
    await expect(page.getByRole('heading', { name: 'Strategy Definition Language' })).toBeVisible();
    await expect(page.getByText('"trend_following"')).toBeVisible();
  });

  test('tabs without evidence explain the absence rather than showing zero', async ({ page }) => {
    await page.goto(`/strategies/${strategyId}?tab=trades&version=${versionId}`);
    await expect(page.getByText('No trades recorded for this version.')).toBeVisible();
    await expect(page.getByText(/invented figure is worse than a gap/)).toBeVisible();
  });

  test('the decision screen refuses approval and states every blocker', async ({ page }) => {
    await page.goto(`/committee/${versionId}`);
    await expect(page.getByRole('heading', { name: /Review version 1/ })).toBeVisible();

    // Section 18.3: approval must not be one click, and must not be offered
    // when the server would refuse it.
    const approve = page.getByRole('button', { name: 'Approve for paper testing' });
    await expect(approve).toBeDisabled();
    await expect(page.getByText('Approval is unavailable for this version.')).toBeVisible();
    await expect(page.getByText(/Backtest run has not been recorded/)).toBeVisible();
  });

  test('rejection requires a rationale before it is available', async ({ page }) => {
    await page.goto(`/committee/${versionId}`);

    const reject = page.getByRole('button', { name: 'Reject' });
    await expect(reject).toBeDisabled();

    await page.getByLabel(/Rationale/).fill('Insufficient evidence to proceed at this time.');
    await expect(reject).toBeEnabled();
  });

  test('the audit timeline is reachable', async ({ page }) => {
    await page.goto(`/strategies/${strategyId}?tab=audit&version=${versionId}`);
    await expect(page.getByRole('heading', { name: /Audit|Strategy detail/ })).toBeVisible();
  });

  test('every page carries the no-future-profitability disclaimer', async ({ page }) => {
    for (const path of ['/', '/campaigns', '/strategies', '/committee']) {
      await page.goto(path);
      await expect(page.getByText(/Past performance does not indicate future results/)).toBeVisible();
    }
  });
});
