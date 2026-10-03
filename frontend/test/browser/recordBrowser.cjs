// RN Web glyph bounds, colors and chart interaction. Actual native navigation
// is covered separately by walletBrowser's production RootNavigator fixture.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.RECORD_BROWSER_OUTPUT ?? '/tmp/trading-record-browser';
const palette = { light: { red_blue: ['rgb(161, 62, 59)', 'rgb(49, 95, 155)'], green_red: ['rgb(22, 128, 58)', 'rgb(161, 62, 59)'] }, dark: { red_blue: ['rgb(255, 139, 134)', 'rgb(140, 186, 255)'], green_red: ['rgb(121, 214, 139)', 'rgb(255, 139, 134)'] } };
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'recordFixture.jsx')], outfile: path.join(out, 'record.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')], resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'], define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, plugins: [{ name: 'record-fixtures', setup(b) {
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
    b.onResolve({ filter: /services\/api\/client$/ }, () => ({ path: path.join(__dirname, 'recordMocks.js') }));
  } }], logLevel: 'warning' });
  const server = http.createServer((req, res) => { const script = req.url.startsWith('/record.js'); res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html'); res.end(script ? fs.readFileSync(path.join(out, 'record.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/record.js"></script>'); }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(), errors = [], records = [], base = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => { const p = new URLSearchParams(location.search); localStorage.setItem('selectedTradingAccountId:home-user', 'general-account'); localStorage.setItem('trading-app:appearance', 'system'); localStorage.setItem('trading-app:financial-colors', p.get('palette') ?? 'red_blue'); });
  const id = value => page.getByTestId(value), color = locator => locator.evaluate(el => getComputedStyle(el).color);
  try {
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const preference of ['red_blue', 'green_red']) for (const fontScale of [1, 2]) for (const long of [0, 1]) for (const screen of (process.env.RECORD_BROWSER_SCREENS?.split(',') ?? ['detail', 'profit', 'history'])) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?record=${screen}&navigation=1&palette=${preference}&fontScale=${fontScale}&long=${long}`);
      await id(screen === 'detail' ? 'record-detail-return' : screen === 'profit' ? 'record-profit-total' : 'record-order-item-order-1').waitFor();
      if (screen !== 'history') {
        const positive = screen === 'detail' ? ['record-detail-return', 'record-detail-pnl'] : ['record-profit-total', 'record-profit-return', 'record-profit-realized', 'record-profit-best-pnl', 'record-profit-best-return'];
        for (const metric of positive) assert.equal(await color(id(metric)), palette[appearance][preference][0], metric);
        if (screen === 'profit') for (const metric of ['record-profit-unrealized', 'record-profit-worst-pnl', 'record-profit-worst-return']) assert.equal(await color(id(metric)), palette[appearance][preference][1], metric);
        assert.equal(await id(screen === 'detail' ? 'record-detail-pnl' : 'record-profit-total').textContent(), long ? '+1,234,567,890,123,456원' : '+777,777원');
        if (screen === 'detail') {
          assert.equal(await id('record-detail-rank').textContent(), '#100000');
          assert.ok(!palette[appearance][preference].includes(await color(id('record-detail-assets'))));
        }
        const text = await page.locator('body').textContent();
        assert.doesNotMatch(text, /MDD|private timestamp|private snapshot|RAW_|domestic_stock|partial_unavailable|총 주문|환전 내역/);
      }
      const clipping = await page.evaluate(() => {
        const viewport = innerWidth, clipped = [], walker = document.createTreeWalker(document.getElementById('root'), NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode, parent = node.parentElement;
          if (!node.textContent.trim() || parent.closest('svg') || getComputedStyle(parent).visibility === 'hidden') continue;
          const box = parent.getBoundingClientRect();
          for (let i = 0; i < node.textContent.length; i++) {
            if (/\s/.test(node.textContent[i])) continue;
            const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
            for (const rect of range.getClientRects()) if (rect.width && (rect.left < -1 || rect.right > viewport + 1 || rect.left < box.left - 1 || rect.right > box.right + 1)) { clipped.push({ text: node.textContent, glyph: node.textContent[i], left: rect.left, right: rect.right, box: [box.left, box.right] }); break; }
          }
        }
        return clipped;
      });
      assert.deepEqual(clipping, [], JSON.stringify({ width, appearance, preference, fontScale, long, screen, clipping: clipping.slice(0, 5) }));
      if (screen === 'profit' && fontScale === 1) {
        const plot = page.locator('[role="img"][aria-label^="차트."] svg');
        await plot.scrollIntoViewIfNeeded();
        const box = await plot.boundingBox();
        await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
        await page.mouse.down();
        await id('line-chart-tooltip').waitFor();
        assert.match(await id('line-chart-tooltip').textContent(), /2026-09-30.*11,234,000원/);
        await page.mouse.up();
        await id('line-chart-tooltip').waitFor({ state: 'hidden' });
      }
      if (width === 320 && long && fontScale === 1 && preference === 'red_blue') await page.screenshot({ path: path.join(out, `${screen}-${appearance}.png`), fullPage: true });
      records.push({ width, appearance, preference, fontScale, long, screen });
    }
    for (const state of ['unavailable', 'partial_unavailable']) {
      await page.goto(`${base}/?record=profit&navigation=1&recordState=${state}`); await id('record-profit-total').waitFor();
      assert.equal(await id('record-profit-total').textContent(), '-');
      assert.equal(await id('record-profit-unrealized').textContent(), '-');
      assert.equal(await id('record-profit-realized').textContent(), state === 'unavailable' ? '-' : '+900,000원');
      assert.doesNotMatch(await page.locator('body').textContent(), /RAW_|domestic_stock/);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ pass: true, records, states: ['unavailable', 'partial_unavailable'], errors }, null, 2));
    console.log(`RECORD_BROWSER_PASSED ${records.length} layouts, semantic palettes, large values, full names, chart tooltip and unavailable states`);
  } finally { await browser.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exit(1); });
