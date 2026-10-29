// Asset detail search sheet and order buttons in RN Web: the name ▼ on a
// domestic, US or crypto spot detail opens the order screen's sheet (2026-10-28:
// every market with its market choice on 전체, no row marked), closes on picking
// the asset on screen and swaps the detail in place for another one — another
// market's too — whose 매수하기 then orders it; 매도하기 / 매수하기 on
// the spot and futures details stay one line inside their buttons. Every text in
// the sheet and the order bars stays inside its root and over no other text, at
// 320/360/390/430 × light/dark × font 1/2. RN-Web only — not a device check.
// Requires esbuild and Playwright (see README).
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const out = process.env.ASSET_SHEET_BROWSER_OUTPUT ?? '/tmp/trading-asset-search-sheet';
const quick = process.env.ASSET_SHEET_QUICK === '1';

/** In page: text inside `root` that leaves it (or the window), or two texts drawn over each other. */
function textProblems(rootId) {
  const root = document.querySelector(`[data-testid="${rootId}"]`);
  if (!root) return [`missing ${rootId}`];
  const box = root.getBoundingClientRect(), words = [], problems = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || node.parentElement.closest('[aria-hidden="true"]')) continue;
    for (const word of node.textContent.matchAll(/\S+/gu)) {
      const range = document.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
      for (const r of range.getClientRects()) words.push({ owner: node.parentElement, text: word[0], r });
    }
  }
  for (const { text, r } of words)
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.right > innerWidth + 0.5) problems.push(`outside: ${text}`);
  for (let i = 0; i < words.length; i += 1) for (let j = i + 1; j < words.length; j += 1) {
    const a = words[i], b = words[j];
    if (a.owner === b.owner || a.owner.contains(b.owner) || b.owner.contains(a.owner)) continue;
    const overlapX = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const overlapY = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (overlapX > 1 && overlapY > 1) problems.push(`overlap: ${a.text} / ${b.text}`);
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}`);
  return problems;
}

/** In page: each labelled button's label is one line inside the button. */
function buttonLines(ids) {
  return ids.map((id) => {
    const button = document.querySelector(`[data-testid="${id}"]`);
    if (!button) return { id, missing: true };
    const box = button.getBoundingClientRect();
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    const lines = new Set(), texts = [];
    let inside = true;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      texts.push(node.textContent.trim());
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        lines.add(Math.round(r.top));
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) inside = false;
      }
    }
    return { id, label: texts.join(' '), lines: lines.size, inside };
  });
}

async function run() {
  fs.mkdirSync(out, { recursive: true });
  const root = path.resolve(__dirname, '../..');
  const mocks = path.join(__dirname, 'tradingMocks.js');
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
      b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: mocks }));
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook|useMarketTickers)$/ }, () => ({ path: mocks }));
    } }],
    logLevel: 'warning',
  });
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url.startsWith('/bundle.js') ? 'text/javascript' : 'text/html');
    res.end(req.url.startsWith('/bundle.js') ? fs.readFileSync(path.join(out, 'bundle.js')) : html);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] })
    .catch((error) => { server.close(); throw error; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [], problems = [], layouts = [];
  // Every detail opens the same sheet the order screen opens: 전체, every market listed.
  const listed = ['BTC', 'BNB', 'PEPE', 'SUI', 'SAMSUNG', 'AAPL'];
  const markets = { crypto: { asset: 'BNB' }, domestic_stock: { asset: 'SAMSUNG' }, us_stock: { asset: 'AAPL' } };
  let page;
  try {
    const widths = quick ? [320] : [320, 360, 390, 430];
    for (const width of widths) for (const theme of ['light', 'dark']) for (const fontScale of [1, 2]) {
      for (const [assetType, market] of Object.entries(markets)) {
        const tag = `${width}/${theme}/${fontScale}/${assetType}`;
        if (page) await page.close();
        page = await browser.newPage(); page.setDefaultTimeout(10000);
        page.on('pageerror', (error) => errors.push(`${tag}: ${error.message}`));
        await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
        await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
        await page.goto(`${base}/?screen=detail&asset=${market.asset}&krx=1&us=1&viewport=1&fontScale=${fontScale}`);
        await page.waitForFunction(() => window.tradingAppearance);
        await page.evaluate((value) => window.tradingAppearance.setPreference(value), theme);
        await page.getByTestId('asset-order-actions').waitFor();
        // The order bar: 매도하기 / 매수하기, one line each, inside their buttons.
        const actions = await page.evaluate(buttonLines, ['asset-detail-open-sell-order', 'asset-detail-open-buy-order']);
        assert.deepEqual(actions.map((a) => [a.label, a.lines, a.inside]), [['매도하기', 1, true], ['매수하기', 1, true]], tag);
        problems.push(...(await page.evaluate(textProblems, 'asset-order-actions')).map((p) => `${tag}/actions: ${p}`));
        // The name ▼: the order screen's sheet.
        await page.getByTestId('asset-name-selector').click();
        await page.getByTestId('order-asset-sheet').waitFor();
        await page.getByTestId(`market-item-${market.asset}`).waitFor();
        await page.waitForTimeout(450);
        const header = await page.getByTestId('order-asset-sheet').getByRole('heading').innerText();
        assert.equal(header.trim(), '종목 선택', tag);
        assert.equal(await page.locator('[data-testid^="order-asset-scope-"]').count(), 4, `${tag}: the market choice`);
        assert.equal(await page.getByTestId('order-asset-scope-all').getAttribute('aria-selected'), 'true', tag);
        const reads = await page.evaluate(() => window.fixture.state.reads.filter((read) => read.startsWith('/assets?')));
        assert.ok(reads.length > 0 && reads.every((read) => !new URL(read, 'http://x').searchParams.get('assetType')), `${tag}: ${reads}`);
        for (const id of listed) assert.equal(await page.getByTestId(`market-item-${id}`).count(), 1, `${tag}: ${id} listed`);
        // As on the order screen, no row is marked.
        assert.equal(await page.locator('[aria-selected="true"][data-testid^="market-item-"]').count(), 0, tag);
        problems.push(...(await page.evaluate(textProblems, 'order-asset-sheet')).map((p) => `${tag}/sheet: ${p}`));
        if (fontScale === 2 || (width === 390 && fontScale === 1)) {
          await page.screenshot({ path: path.join(out, `sheet-${assetType}-${width}-${theme}-${fontScale}.png`) });
        }
        // Picking the asset on screen only closes the sheet.
        await page.getByTestId(`market-item-${market.asset}`).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="order-asset-sheet"]'));
        assert.deepEqual(await page.evaluate(() => window.fixture.state.paramCalls ?? []), [], tag);
        layouts.push(tag);
      }
      // Another asset swaps the detail in place; its 매수하기 orders it.
      const tag = `${width}/${theme}/${fontScale}/switch`;
      await page.goto(`${base}/?screen=detail&asset=BNB&krx=1&us=1&viewport=1&fontScale=${fontScale}`);
      await page.waitForFunction(() => window.tradingAppearance);
      await page.evaluate((value) => window.tradingAppearance.setPreference(value), theme);
      await page.getByTestId('asset-name-selector').click();
      await page.getByTestId('market-item-BTC').waitFor(); await page.waitForTimeout(450);
      await page.getByTestId('market-item-BTC').click();
      await page.waitForFunction(() => window.fixture.state.assetId === 'BTC');
      await page.waitForFunction(() => /현재 Bitcoin/.test(document.querySelector('[data-testid="asset-name-selector"]')?.getAttribute('aria-label') ?? ''));
      assert.deepEqual(await page.evaluate(() => window.fixture.state.paramCalls), [{ assetId: 'BTC' }], tag);
      await page.getByTestId('asset-name-selector').click();
      await page.getByTestId('market-item-BTC').waitFor(); await page.waitForTimeout(450);
      await page.getByTestId('order-asset-sheet-close').click();
      await page.waitForFunction(() => !document.querySelector('[data-testid="order-asset-sheet"]'));
      await page.getByTestId('asset-detail-open-buy-order').click();
      // The order screen and its inline panel share the id.
      await page.getByTestId('order-screen').first().waitFor();
      assert.deepEqual(await page.evaluate(() => [window.fixture.state.assetId, window.fixture.state.side]), ['BTC', 'buy'], tag);
      // The futures detail: 매도하기 = new short, 매수하기 = new long, one line each.
      const futuresTag = `${width}/${theme}/${fontScale}/futures`;
      await page.goto(`${base}/?screen=market&asset=SUI&viewport=1&fontScale=${fontScale}`);
      await page.waitForFunction(() => window.tradingAppearance);
      await page.evaluate((value) => window.tradingAppearance.setPreference(value), theme);
      await page.getByRole('tab', { name: '암호화폐', exact: true }).click();
      await page.getByTestId('crypto-product-futures').click();
      await page.getByTestId('futures-market-btc').click();
      await page.getByTestId('futures-detail-actions').waitFor();
      const futuresActions = await page.evaluate(buttonLines, ['futures-detail-short', 'futures-detail-long']);
      assert.deepEqual(futuresActions.map((a) => [a.label, a.lines, a.inside]), [['매도하기', 1, true], ['매수하기', 1, true]], futuresTag);
      problems.push(...(await page.evaluate(textProblems, 'futures-detail-actions')).map((p) => `${futuresTag}: ${p}`));
      if (fontScale === 2) await page.screenshot({ path: path.join(out, `futures-detail-${width}-${theme}-${fontScale}.png`) });
      await page.getByTestId('futures-detail-short').click();
      await page.getByTestId('futures-screen').waitFor();
      assert.equal(await page.evaluate(() => window.fixture.state.direction), 'short', futuresTag);
      layouts.push(tag, futuresTag);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(problems, []);
    const report = { status: 'PASS', layouts: layouts.length, native: 'NOT_RUN' };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
