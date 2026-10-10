// Optional real RN Web layout check. Requires external esbuild and Playwright.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.ORDER_BROWSER_OUTPUT ?? '/tmp/trading-order-browser';

async function run() {
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
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
      b.onResolve({ filter: /CandlestickChartRenderer$/ }, (args) => args.importer.endsWith('rendererProbe.jsx') ? undefined : ({ path: path.join(__dirname, 'rendererProbe.jsx') }));
    } }],
    logLevel: 'warning',
  });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  const server = http.createServer((req, res) => {
    const js = req.url.startsWith('/bundle.js');
    res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(out, js ? 'bundle.js' : 'index.html')));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  // The app default is Light; follow the emulated scheme like the other browser checks.
  await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  try {
    for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?screen=home`);
      await page.getByText('총 자산', { exact: true }).waitFor();
      await theme.canvas(page, appearance);
      // Borderless Home cards: Light Home paints the existing raised tone as its canvas.
      const homeCanvas = appearance === 'light' ? 'raised' : 'screen';
      await theme.background(page.getByTestId('trading-account-general-summary'), appearance, homeCanvas);
      await theme.background(page.getByText('총 자산', { exact: true }), appearance, homeCanvas);
      await page.getByTestId('home-trend-toggle').click();
      await page.getByTestId('home-trend-chart').waitFor();
      assert.equal(await page.getByText('자금 구성', { exact: true }).count(), 0);
      for (const label of ['보유종목 및 포지션', 'HOT 🔥', '자산 추이']) {
        await theme.background(page.getByText(label, { exact: true }), appearance, 'surface');
      }
      await page.screenshot({ path: path.join(out, `home-${appearance}.png`), fullPage: true });
      await page.goto(`${base}/?screen=market`);
      await page.getByTestId('market-item-SUI').waitFor();
      await theme.canvas(page, appearance);
      await theme.background(page.getByTestId('market-screen'), appearance, 'screen');
      await theme.background(page.getByTestId('market-item-SUI'), appearance, 'surface');
      await theme.background(page.getByText('종목명 또는 심볼 검색', { exact: true }), appearance, 'raised');
      await page.screenshot({ path: path.join(out, `market-${appearance}.png`), fullPage: true });
      await page.goto(`${base}/?screen=detail&asset=SUI`);
      await page.getByTestId('asset-settlement-currency').waitFor();
      await theme.canvas(page, appearance);
      await theme.background(page.getByTestId('asset-detail-name'), appearance, 'surface');
      await theme.background(page.getByTestId('asset-settlement-currency'), appearance, 'raised');
      await page.screenshot({ path: path.join(out, `detail-${appearance}.png`), fullPage: true });
      await page.getByTestId('asset-timeframe-selector').click();
      await page.getByTestId('asset-timeframe-close').waitFor();
      await theme.background(page.getByRole('heading', { name: '시간봉', exact: true }), appearance, 'surface');
      await theme.background(page.getByTestId('asset-timeframe-close'), appearance, 'raised');
      await page.getByTestId('asset-timeframe-close').click();
    }
    console.log('appearance hierarchy ok (Home, Market, Detail, timeframe sheet × light/dark)');
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?screen=order&asset=SUI`);
      const byId = (id) => page.getByTestId(id);
      await byId('asset-trading-columns').waitFor();
      await theme.canvas(page, appearance);
      await theme.background(byId('asset-trading-columns'), appearance, 'surface');
      await theme.background(byId('order-quantity-input'), appearance, 'raised');
      const columns = await page.evaluate(() => {
        const rect = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
        const left = rect('asset-order-column'), right = rect('asset-price-column');
        const row = rect('asset-trading-columns');
        return { left: { x: left.x, y: left.y, width: left.width }, right: { x: right.x, y: right.y, width: right.width }, row: { width: row.width }, background: getComputedStyle(document.querySelector('[data-testid="asset-order-column"]')).backgroundColor };
      });
      assert.ok(columns.left.width > 100 && columns.right.width > 100, `${appearance}/${width}: both columns have space`);
      assert.ok(Math.abs(columns.left.y - columns.right.y) < 2, `${appearance}/${width}: columns remain side by side`);
      assert.ok(columns.left.x + columns.left.width <= columns.right.x + 1, `${appearance}/${width}: no overlap`);
      assert.ok(columns.right.x + columns.right.width <= width + 1, `${appearance}/${width}: quote stays onscreen`);
      const input = byId('order-quantity-input');
      await input.fill('123456789.123456789');
      assert.equal(await input.inputValue(), '123456789.123456789');
      assert.equal(await input.getAttribute('placeholder'), '매수 금액 입력');
      await byId('order-type-select').click();
      await byId('order-type-toggle-limit').click();
      const limit = byId('order-limit-price-input');
      await limit.fill('0.000000123456789');
      assert.equal(await limit.inputValue(), '0.000000123456789');
      const visuals = await limit.evaluate((node) => {
        const style = getComputedStyle(node);
        return { width: node.getBoundingClientRect().width, color: style.color, background: style.backgroundColor, lineHeight: style.lineHeight, caretColor: style.caretColor };
      });
      assert.ok(visuals.width > 100 && visuals.color !== visuals.background, `${appearance}/${width}: actual input text is visible`);
      assert.notEqual(visuals.caretColor, visuals.background, `${appearance}/${width}: caret is visible`);
      const longDecimal = '0.' + '1234567890'.repeat(5);
      await limit.fill(longDecimal);
      const caret = await limit.evaluate((node) => ({ value: node.value, end: node.selectionEnd, scrollLeft: node.scrollLeft, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      assert.equal(caret.value, longDecimal);
      assert.equal(caret.end, longDecimal.length);
      assert.ok(caret.scrollWidth > caret.clientWidth && caret.scrollLeft > 0, `${appearance}/${width}: native input scrolls its caret`);
      for (const ratio of [25, 50, 75, 100]) await byId(`order-ratio-${ratio}`).click();
      await byId('asset-detail-sell-button').click();
      const quantity = byId('order-quantity-input');
      assert.equal(await quantity.getAttribute('placeholder'), '수량 입력');
      await quantity.fill(longDecimal);
      assert.equal(await quantity.inputValue(), longDecimal);
      await page.screenshot({ path: path.join(out, `order-${appearance}-${width}.png`), fullPage: true });
      console.log(JSON.stringify({ appearance, width, columns, visuals, caret }));
    }
    await page.goto(`${base}/?screen=order&asset=BTC`);
    await page.getByTestId('order-quantity-input').fill('1');
    await page.getByTestId('order-execute-submit').click();
    await page.waitForTimeout(500);
    assert.equal((await page.evaluate(() => window.fixture.state.requests)).length, 2, 'quote and create remain connected');
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${base}/?screen=detail&asset=SUI&longName=1`);
    await page.getByTestId('asset-settlement-currency').waitFor();
    const badge = await page.evaluate(() => {
      const name = document.querySelector('[data-testid="asset-detail-name"]');
      const badge = document.querySelector('[data-testid="asset-settlement-currency"]');
      const rect = (node) => node.getBoundingClientRect();
      return { name: name.textContent, nameBox: { right: rect(name).right, bottom: rect(name).bottom }, currency: badge.textContent, badgeBox: { left: rect(badge).left, right: rect(badge).right, top: rect(badge).top } };
    });
    assert.match(badge.name, /Extended Settlement Example/);
    assert.equal(badge.currency, 'USD');
    assert.ok(badge.badgeBox.right <= 320 && badge.nameBox.right <= 320, 'long name and settlement badge stay onscreen');
    await page.getByTestId('asset-currency-krw').click();
    assert.equal(await page.getByTestId('asset-settlement-currency').innerText(), 'USD');
    console.log('BADGE', JSON.stringify(badge));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
