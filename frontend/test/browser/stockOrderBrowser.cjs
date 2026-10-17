// Optional real RN Web check of the stock order card (A-2 시안): the two
// columns at every width, 시세 / 내 보유 / 예상 주문 in the right column, the
// card's figures following the inputs, and no clipped or overlapping text at
// 320/360/390/430px, light/dark and 1x/1.5x fonts. Crypto keeps its order book.
// Requires external esbuild and Playwright (see README). `STOCK_ORDER_QUICK=1`
// runs 360/light/1x and 320/dark/1.5x only.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.STOCK_ORDER_BROWSER_OUTPUT ?? '/tmp/trading-stock-order-browser';

/** Cut or overlapping text inside one container; skips hidden measurers. */
async function textIssues(page, testId) {
  return page.evaluate((testId) => {
    const scope = document.querySelector(`[data-testid="${testId}"]`);
    if (!scope) return [`missing ${testId}`];
    const visible = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        // Stacked labels (the side segment's active/inactive pair) fade to 0.
        if (node.getAttribute('aria-hidden') === 'true' || parseFloat(style.opacity) < 0.05 || style.visibility === 'hidden' || style.display === 'none') return false;
      }
      return true;
    };
    const issues = [], boxes = [];
    for (const el of scope.querySelectorAll('div, span')) {
      const own = [...el.childNodes].filter((node) => node.nodeType === 3 && node.textContent.trim());
      if (!own.length || !visible(el)) continue;
      const style = getComputedStyle(el);
      if (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none') issues.push(`ellipsis: ${el.textContent.slice(0, 40)}`);
      // Each text node's glyph runs (\S+), so a hanging trailing space never counts.
      for (const node of own) {
        const range = document.createRange();
        for (const match of node.textContent.matchAll(/\S+/gu)) {
          range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
          for (const rect of range.getClientRects()) {
            if (!rect.width) continue;
            boxes.push({ text: match[0], left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
            // Clipping ancestors, per axis. Along an axis a container scrolls,
            // its content is reached by scrolling: not cut, and nothing above
            // that container clips it either.
            for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
              const ps = getComputedStyle(parent);
              const scrollsX = /auto|scroll/u.test(ps.overflowX), scrollsY = /auto|scroll/u.test(ps.overflowY);
              const box = parent.getBoundingClientRect();
              const cutX = ps.overflowX !== 'visible' && !scrollsX && (rect.right > box.right + 1 || rect.left < box.left - 1);
              const cutY = ps.overflowY !== 'visible' && !scrollsY && (rect.bottom > box.bottom + 1 || rect.top < box.top - 1);
              if (cutX || cutY) { issues.push(`cut: ${match[0]}`); break; }
              if (scrollsX || scrollsY) break;
            }
          }
        }
      }
    }
    // Two glyph runs drawn on top of each other (e.g. a label under its value).
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 2 && y > 2) issues.push(`overlap: ${a.text} / ${b.text}`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`page scrolls sideways: ${document.documentElement.scrollWidth}`);
    return issues;
  }, testId);
}

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
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BEGINNER_CHROMIUM || process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = [];
  // Each scenario: fixture query, the order it fills in, and what the card must say.
  const scenarios = [
    { name: 'krx-limit-buy', query: 'krx=1&asset=SAMSUNG&stock=1&holding=12', method: 'limit', price: '69000', quantity: '2',
      expect: { badge: '체결 대기', total: '138,138원', after: '7,161,936원', max: '105주', holding: '12주' } },
    { name: 'krx-closed-limit', query: 'krx=1&krxClosed=1&asset=SAMSUNG&stock=1&holding=12&otherHolding=1', method: 'limit', price: '70000', quantity: '2',
      expect: { badge: '정규장 대기', total: '140,140원', holding: '12주', others: true } },
    { name: 'krx-market-sell', query: 'krx=1&asset=SAMSUNG&stock=1&holding=12', side: 'sell', quantity: '3',
      expect: { badge: '즉시 체결', total: '209,790원', after: '9주', holding: '12주' } },
    { name: 'krx-no-holding', query: 'krx=1&asset=SAMSUNG&stock=1&holding=0', method: 'market', quantity: '1',
      expect: { badge: '즉시 체결', total: '70,070원', empty: true } },
    { name: 'krx-long-values', query: 'krx=1&asset=SAMSUNG&stock=1&holding=1234&krxPrice=12720000&longName=1&krwBalance=987654321098', method: 'limit', price: '12720000', quantity: '7654',
      expect: { badge: '체결 대기', holding: '1,234주' } },
    { name: 'us-market-buy', query: 'us=1&asset=AAPL&stock=1&holding=5', method: 'market', quantity: '2',
      expect: { badge: '즉시 체결', holding: '5주', usd: true } },
  ];
  let selfTested = false;
  try {
    const quick = process.env.STOCK_ORDER_QUICK === '1';
    const combos = [];
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const fontScale of [1, 1.5]) combos.push([width, appearance, fontScale]);
    for (const [width, appearance, fontScale] of quick ? [[360, 'light', 1], [320, 'dark', 1.5]] : combos) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
      await page.emulateMedia({ colorScheme: appearance });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
      const tag = `${width}-${appearance}-${fontScale}x`;
      const text = async (id) => (await page.getByTestId(id).first().innerText()).replace(/\s+/gu, ' ').trim();
      for (const scenario of scenarios) {
        await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&side=${scenario.side ?? 'buy'}&${scenario.query}`);
        await page.getByTestId('order-type-select').waitFor();
        if (scenario.side === 'sell') await page.getByTestId('asset-detail-sell-button').click();
        if (scenario.method && scenario.method !== 'market') {
          await page.getByTestId('order-type-select').click();
          await page.getByTestId(`order-method-${scenario.method}`).click();
          await page.waitForTimeout(450);
        }
        if (scenario.price) await page.getByTestId('order-limit-price-input').fill(scenario.price);
        await page.getByTestId('order-quantity-input').fill(scenario.quantity);
        await page.waitForFunction(() => document.querySelector('[data-testid="order-holding-quantity-value"], [data-testid="order-holding-empty"]'));
        await page.waitForTimeout(150);
        const where = `${scenario.name} ${tag}`;
        // Two columns side by side at every width.
        const left = await page.getByTestId('asset-order-column').boundingBox(), right = await page.getByTestId('asset-price-column').boundingBox();
        assert.ok(right.x >= left.x + left.width - 1 && Math.abs(right.y - left.y) < 2, `two columns (${where})`);
        for (const id of ['asset-current-price', 'order-holding-summary', 'order-indicative-preview']) {
          const box = await page.getByTestId(id).boundingBox();
          assert.ok(box.x >= right.x - 1 && box.x + box.width <= right.x + right.width + 1, `${id} in the right column (${where})`);
        }
        assert.equal(await page.getByTestId('order-summary-badge').innerText(), scenario.expect.badge, `badge (${where})`);
        if (scenario.expect.total) assert.equal(await text('order-summary-total-value'), scenario.expect.total, `total (${where})`);
        if (scenario.expect.after) assert.equal(await text('order-summary-after-value'), scenario.expect.after, `after (${where})`);
        if (scenario.expect.max) assert.equal(await text('order-max-quantity-value'), scenario.expect.max, `max (${where})`);
        if (scenario.expect.holding) assert.equal(await text('order-holding-quantity-value'), scenario.expect.holding, `holding (${where})`);
        if (scenario.expect.empty) assert.equal(await page.getByTestId('order-holding-empty').count(), 1, `no holding (${where})`);
        if (scenario.expect.others) {
          assert.equal(await page.getByTestId('holding-SAMSUNG').count(), 0, `the current holding is not listed twice (${where})`);
          assert.equal(await page.getByTestId('holding-HYNIX').count(), 1, `other holdings listed (${where})`);
        }
        if (scenario.expect.usd) assert.match(await text('order-summary-total-value'), /^\$\d/u, `USD figures (${where})`);
        // The unit sits inside the quantity field, clear of the typed value.
        const unit = await page.getByTestId('order-quantity-input-unit').boundingBox();
        const field = await page.getByTestId('order-quantity-input').boundingBox();
        const padding = await page.getByTestId('order-quantity-input').evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
        assert.ok(unit.x + unit.width <= field.x + field.width && padding >= unit.width + 4, `unit inside the field (${where})`);
        const issues = [...await textIssues(page, 'asset-trading-columns'), ...await textIssues(page, 'asset-pair-header')];
        if (!selfTested && !issues.length) {
          // Negative controls: the detector must fire on a forced overflow and a forced overlap.
          await page.evaluate(() => {
            const total = document.querySelector('[data-testid="order-summary-total-value"]');
            total.dataset.saved = total.textContent;
            total.textContent = '999,999,999,999,999,999,999,999원';
            total.style.whiteSpace = 'nowrap';
          });
          const forcedCut = await textIssues(page, 'asset-trading-columns');
          assert.ok(forcedCut.some((issue) => /^cut: 999/u.test(issue)), `the detector catches clipped text ${JSON.stringify(forcedCut.slice(0, 3))}`);
          await page.evaluate(() => {
            const total = document.querySelector('[data-testid="order-summary-total-value"]');
            total.textContent = total.dataset.saved;
            total.style.whiteSpace = '';
            // Onto the row above (rows align on baselines, so offset it, not its margin).
            const fee = document.querySelector('[data-testid="order-summary-fee-value"]');
            const above = document.querySelector('[data-testid="order-summary-quantity-value"]');
            fee.style.top = `${above.getBoundingClientRect().top - fee.getBoundingClientRect().top}px`;
          });
          const forcedOverlap = await textIssues(page, 'asset-trading-columns');
          assert.ok(forcedOverlap.some((issue) => issue.startsWith('overlap:')), `the detector catches overlapping text ${JSON.stringify(forcedOverlap.slice(0, 3))}`);
          selfTested = true;
        }
        report.push({ shot: `${scenario.name}-${tag}`, issues, errors: [...errors] });
        const card = await page.getByTestId('asset-trading-columns').boundingBox();
        await page.screenshot({ path: path.join(out, `${scenario.name}-${tag}.png`), clip: { x: 0, y: 0, width, height: Math.min(card.y + card.height + 16, 900) } });
      }
      // 접기 folds 시세 only.
      await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&krx=1&asset=SAMSUNG&stock=1&holding=12`);
      await page.getByTestId('order-quote-toggle').click();
      assert.deepEqual([await page.getByTestId('asset-current-price').count(), await page.getByTestId('order-holding-summary').count(),
        await page.getByTestId('order-indicative-preview').count()], [0, 1, 1], `fold (${tag})`);
      report.push({ shot: `folded-${tag}`, issues: await textIssues(page, 'asset-trading-columns'), errors: [...errors] });
      // Crypto keeps its form beside the order book.
      await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&asset=SUI`);
      await page.getByTestId('order-type-select').waitFor();
      assert.equal(await page.getByTestId('order-quote-toggle').count(), 0, `crypto has no stock card (${tag})`);
      assert.equal(await page.getByTestId('asset-order-book').count() > 0, true, `crypto order book (${tag})`);
      await page.close();
    }
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    server.close();
  }
  const bad = report.filter((entry) => entry.issues.length || entry.errors.length);
  assert.equal(selfTested, true, 'the negative controls ran');
  console.log(JSON.stringify({ screens: report.length, problems: bad.length, detectorSelfTest: selfTested, out }, null, 2));
  if (bad.length) {
    console.log(JSON.stringify(bad.slice(0, 20), null, 2));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
