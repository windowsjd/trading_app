// Optional real RN Web check of the Tiingo trial UI (estimated quote card and
// trial-source notices) with SYNTHETIC fixture data. Requires external esbuild
// and Playwright (see test/browser/README.md). Not part of `npm test`.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.TIINGO_BROWSER_OUTPUT ?? '/tmp/trading-tiingo-trial-browser';

async function build() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'tradingFixture.jsx')],
    outfile: path.join(out, 'bundle.js'), bundle: true, minify: true,
    platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    loader: { '.png': 'dataurl' },
    plugins: [{ name: 'isolated-trading-boundaries', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook|useAssetEstimatedQuote|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
      b.onResolve({ filter: /CandlestickChartRenderer$/ }, (args) => args.importer.endsWith('rendererProbe.jsx') ? undefined : ({ path: path.join(__dirname, 'rendererProbe.jsx') }));
    } }],
    logLevel: 'warning',
  });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
}

/** Visible text that is clipped or pushes the page sideways. */
async function overflow(page, testId) {
  return page.evaluate((id) => {
    const scope = document.querySelector(`[data-testid="${id}"]`);
    if (!scope) return ['missing scope'];
    const width = document.documentElement.clientWidth;
    const issues = [];
    if (document.documentElement.scrollWidth > width + 1) issues.push(`page scroll ${document.documentElement.scrollWidth}>${width}`);
    const scrollable = (el) => {
      for (let node = el.parentElement; node && node !== scope.parentElement; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.overflowX === 'auto' || css.overflowX === 'scroll') return true;
      }
      return false;
    };
    for (const el of scope.querySelectorAll('div')) {
      if (!el.childNodes.length || [...el.childNodes].some((n) => n.nodeType === 1)) continue;
      // Inside a horizontal scroller the value is reachable, not clipped.
      if (scrollable(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (el.scrollWidth > el.clientWidth + 1) issues.push(`clipped: ${el.textContent}`);
      if (rect.right > width + 1) issues.push(`off-screen: ${el.textContent}`);
    }
    return issues;
  }, testId);
}

async function run() {
  await build();
  const server = http.createServer((req, res) => {
    const js = req.url.startsWith('/bundle.js');
    res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(out, js ? 'bundle.js' : 'index.html')));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.BROWSER_CHROMIUM ? { executablePath: process.env.BROWSER_CHROMIUM } : {}),
  });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const results = [];
  try {
    const cases = [
      ...['light', 'dark'].flatMap((appearance) => [320, 390, 768].map((width) => ({ appearance, width, fontScale: 1, extra: '' }))),
      { appearance: 'light', width: 320, fontScale: 2, extra: '' },
      { appearance: 'dark', width: 320, fontScale: 2, extra: '&usLong=1' },
      { appearance: 'light', width: 390, fontScale: 1, extra: '&usAsk=none' },
    ];
    for (const { appearance, width, fontScale, extra } of cases) {
      const label = `${appearance}-${width}-x${fontScale}${extra.replace(/[&=]/g, '_')}`;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?screen=order&asset=AAPL&us=1&fontScale=${fontScale}${extra}`);
      const card = page.getByTestId('asset-estimated-quote');
      await card.waitFor();
      await theme.canvas(page, appearance);
      const cardText = await card.innerText();
      assert.match(cardText, /추정 호가/);
      assert.match(cardText, /Tiingo 통계 추정/);
      assert.match(cardText, /실제 거래소 호가\(주문장\)가 아니며 주문 체결에 사용되지 않습니다\./);
      if (extra.includes('usAsk=none')) assert.match(await page.getByTestId('asset-estimated-quote-ask').innerText(), /미제공/);
      else assert.match(await page.getByTestId('asset-estimated-quote-ask').innerText(), /주/);
      assert.equal(await page.getByTestId('asset-order-book').count(), 0, 'no 10-level ladder for the estimate');
      assert.match(await page.getByTestId('asset-trial-price-notice').innerText(), /Tiingo 체험 데이터/);
      await page.waitForTimeout(150);
      const issues = await overflow(page, 'asset-estimated-quote');
      await card.screenshot({ path: path.join(out, `order-card-${label}.png`) });
      await page.screenshot({ path: path.join(out, `order-${label}.png`), fullPage: true });

      await page.goto(`${base}/?screen=detail&asset=AAPL&us=1&fontScale=${fontScale}${extra}`);
      await page.getByTestId('asset-trial-candle-notice').waitFor();
      assert.match(await page.getByTestId('asset-trial-price-notice').innerText(), /Tiingo 참조가/);
      assert.match(await page.getByTestId('asset-trial-candle-notice').innerText(), /받은 30\/96거래일 구간만 표시 · 마지막 봉은 조회 시점의 진행 중 봉/);
      await theme.canvas(page, appearance);
      await page.screenshot({ path: path.join(out, `detail-${label}.png`), fullPage: true });
      results.push({ label, overflow: issues });
    }
    // Crypto keeps its order book and never subscribes estimates.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}/?screen=order&asset=SUI&us=1`);
    await page.getByTestId('asset-order-book').waitFor();
    assert.equal(await page.getByTestId('asset-estimated-quote').count(), 0);
    assert.equal(await page.getByTestId('asset-trial-price-notice').count(), 0);
    assert.deepEqual(errors, []);
    const failures = results.filter((result) => result.overflow.length);
    console.log(JSON.stringify({ check: 'tiingoTrialBrowser', screens: results.length * 2 + 1, failures, out }, null, 2));
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
