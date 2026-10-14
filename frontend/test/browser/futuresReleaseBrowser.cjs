// Futures release layout check: Market › 선물 list (24h stats, sort), contract
// chart, USDⓈ-M ten-level book (normal/large/stale/loading/unavailable),
// 시장가·지정가·조건주문 forms, position card with TP/SL, pending 조건주문 rows and
// refusal states — at 320/360/390/430 px, light/dark, font scale 1/2. Real
// screens on RN Web; only transport, account, navigation and font scale are
// fixtures. Native iOS/Android rendering is not exercised here.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.FUTURES_RELEASE_BROWSER_OUTPUT ?? '/tmp/trading-futures-release-browser';
const quick = process.env.FUTURES_RELEASE_QUICK === '1';

function bundle(entry, mocks, filter, file) {
  return esbuild.build({ entryPoints: [path.join(__dirname, entry)], outfile: path.join(out, file), bundle: true, minify: true, platform: 'browser', format: 'iife',
    nodePaths: [path.join(root, 'node_modules')], resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, logLevel: 'warning',
    plugins: [{ name: 'fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: path.join(__dirname, mocks) }));
      b.onResolve({ filter }, () => ({ path: path.join(__dirname, mocks) }));
    } }] });
}

/** Every painted text glyph and box must stay inside its own box, its clipping
 * ancestors and the viewport. Deliberate horizontal scrollers (the order
 * ladder) may be wider than the screen, but never overlap inside a row. */
function inspect(page) {
  return page.evaluate(() => {
    const issues = [];
    const invisible = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const s = getComputedStyle(n);
      if (n.getAttribute('aria-hidden') === 'true' || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return true; } return false; };
    const clipped = (el, r) => { let { left, right, top, bottom } = r;
      for (let n = el.parentElement; n; n = n.parentElement) { const s = getComputedStyle(n), b = n.getBoundingClientRect();
        if (s.overflowX !== 'visible') { left = Math.max(left, b.left); right = Math.min(right, b.right); }
        // Vertical scroll views reveal what is below; only a hidden overflow cuts.
        if (s.overflowY === 'hidden' || s.overflowY === 'clip') { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); } }
      return { left, right, top, bottom }; };
    if (document.scrollingElement.scrollWidth > innerWidth + 1) issues.push({ reason: 'page-hscroll', width: document.scrollingElement.scrollWidth });
    for (const el of document.querySelectorAll('div,span,input,textarea,button,a')) {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height || invisible(el)) continue;
      const scroller = el.closest('[data-testid$="-scroll"]');
      const c = clipped(el, r); const painted = c.right > c.left && c.bottom > c.top;
      if (painted && !scroller && (c.left < -1 || c.right > innerWidth + 1)) issues.push({ reason: 'box', text: el.textContent.slice(0, 80), rect: [Math.round(c.left), Math.round(c.right)] });
      const s = getComputedStyle(el);
      if (s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) issues.push({ reason: 'ellipsis', text: el.textContent.slice(0, 80) });
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
        for (const m of node.textContent.matchAll(/\S+/gu)) {
          const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
          for (const t of range.getClientRects()) {
            if (!t.width) continue;
            const outside = t.left < r.left - 1 || t.right > r.right + 1 || ((s.overflow === 'hidden' || s.overflowY === 'hidden') && (t.top < r.top - 1 || t.bottom > r.bottom + 1));
            const cut = t.left < c.left - 1 || t.right > c.right + 1 || t.top < c.top - 1 || t.bottom > c.bottom + 1;
            const offscreen = !scroller && (t.left < -1 || t.right > innerWidth + 1);
            if (outside || offscreen || (painted && cut && !scroller)) issues.push({ reason: outside ? 'glyph' : offscreen ? 'offscreen' : 'clipped', text: m[0], in: el.textContent.slice(0, 60) });
          }
        }
      }
    }
    // Ladder rows: the price and quantity numbers must not touch.
    for (const row of document.querySelectorAll('[data-testid^="asset-order-book-asks-"],[data-testid^="asset-order-book-bids-"]')) {
      if (/-scroll$|-(asks|bids)$/.test(row.dataset.testid)) continue;
      const cells = [...row.children].map((cell) => { const range = document.createRange(); range.selectNodeContents(cell); return range.getBoundingClientRect(); });
      if (cells.length === 2 && cells[0].right > cells[1].left - 2 && cells[1].width) issues.push({ reason: 'ladder-overlap', text: row.getAttribute('aria-label') });
    }
    return issues;
  });
}

/** Proves the detector: it must fire on cut text (also in mixed text nodes)
 * and off-screen boxes, and stay silent under an opacity-0 ancestor. */
async function selfTest(page) {
  const found = await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'detector-controls';
    host.innerHTML = '<div style="width:40px;white-space:nowrap;font-size:14px">negative-control-wide-text</div>'
      + '<div style="width:40px;white-space:nowrap;font-size:14px"><span>a</span> mixed-node-overflowing-text</div>'
      + '<div style="position:relative;left:-80px;width:60px;height:10px"></div>'
      + '<div style="height:12px;overflow:hidden"><div style="font-size:20px;line-height:40px">vertical-clip-control</div></div>'
      + '<div style="opacity:0"><div style="width:10px;white-space:nowrap">hidden-overflow-ignored</div></div>';
    document.body.prepend(host); return true;
  });
  assert.equal(found, true);
  const issues = await inspect(page);
  await page.evaluate(() => document.getElementById('detector-controls').remove());
  const texts = issues.map((i) => i.text ?? '');
  assert.ok(texts.some((t) => t.includes('negative-control-wide-text')), 'detector: single text node');
  assert.ok(texts.some((t) => t.includes('mixed-node-overflowing-text')), 'detector: mixed text nodes');
  assert.ok(issues.some((i) => i.reason === 'box'), 'detector: off-screen box');
  assert.ok(texts.some((t) => t.includes('vertical-clip-control')), 'detector: vertical clip by a hidden ancestor');
  assert.ok(!texts.some((t) => t.includes('hidden-overflow-ignored')), 'detector: opacity-0 ancestor ignored');
}

const LIST_ORDER = {
  turnover_desc: ['large', 'btc', 'eth', 'tiny', 'long', 'no-last', 'stats-off'],
  turnover_asc: ['no-last', 'long', 'tiny', 'eth', 'btc', 'large', 'stats-off'],
  change_desc: ['large', 'no-last', 'eth', 'tiny', 'btc', 'long', 'stats-off'],
  change_asc: ['long', 'btc', 'tiny', 'eth', 'no-last', 'large', 'stats-off'],
};
const SCENARIOS = ['list', 'list-detail', 'chart', 'book', 'book-large', 'book-stale', 'book-loading', 'book-unavailable',
  'market-order', 'limit-order', 'conditional', 'conditional-error', 'pending-conditional', 'position-isolated', 'position-cross', 'refusal'];

async function main() {
  fs.mkdirSync(out, { recursive: true });
  await bundle('tradingFixture.jsx', 'tradingMocks.js', /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook|useMarketTickers)$/, 'trading.js');
  await bundle('futuresFixture.jsx', 'futuresMocks.js', /(services\/api\/client|TradingAccountContext|useFuturesOrderBook)$/, 'futures.js');
  const page0 = (file) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/${file}"></script>`;
  const server = http.createServer((req, res) => {
    const file = req.url.startsWith('/trading.js') ? 'trading.js' : req.url.startsWith('/futures.js') ? 'futures.js' : null;
    res.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
    res.end(file ? fs.readFileSync(path.join(out, file)) : page0(req.url.startsWith('/f') ? 'futures.js' : 'trading.js'));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] }).catch((e) => { server.close(); throw e; });
  const base = `http://127.0.0.1:${server.address().port}`, errors = [], results = [], findings = [];
  let page;
  try {
    const widths = quick ? [320] : [320, 360, 390, 430];
    for (const width of widths) for (const theme of ['light', 'dark']) for (const fontScale of [1, 2]) for (const scenario of SCENARIOS) {
      if (page) await page.close();
      page = await browser.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', (e) => errors.push(`${scenario}: ${e.message}`));
      await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 }); await page.emulateMedia({ colorScheme: theme });
      const futuresBundle = scenario.startsWith('position-') || scenario === 'refusal';
      const query = futuresBundle
        ? `/f?kind=${scenario === 'position-cross' ? 'cross' : scenario === 'refusal' ? 'open' : 'isolated'}&protection=${scenario === 'position-cross' ? 'active' : 'editor'}${scenario === 'refusal' ? '&mode=REDUCE_ONLY' : ''}`
        : `/t?screen=${scenario.startsWith('list') ? 'market' : 'futures'}&futuresList=${scenario.startsWith('list') ? 1 : 0}&conditional=rows`
          + `&futuresBook=${{ 'book-large': 'large', 'book-stale': 'stale', 'book-loading': 'loading', 'book-unavailable': 'unavailable' }[scenario] ?? 'book'}`;
      await page.goto(`${base}${query}&fontScale=${fontScale}`);
      const appearance = futuresBundle ? 'futuresAppearance' : 'tradingAppearance';
      await page.waitForFunction((name) => window[name], appearance);
      await page.evaluate(([name, value]) => window[name].setPreference(value), [appearance, theme]);
      const pick = async (method) => { await page.getByTestId('order-type-select').click(); await page.getByTestId(`order-method-${method}`).click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="order-method-sheet"]')); };
      const tab = (name) => page.getByRole('tab', { name, exact: true }).click();
      if (scenario.startsWith('list')) {
        await tab('암호화폐'); await page.getByTestId('crypto-product-futures').click(); await page.getByTestId('futures-market-btc').waitFor();
        const order = () => page.$$eval('[data-testid^="futures-market-"]', (rows) => rows.map((r) => r.dataset.testid.slice('futures-market-'.length)).filter((id) => id !== 'list'));
        if (scenario === 'list') {
          assert.deepEqual(await order(), LIST_ORDER.turnover_desc, 'default turnover desc');
          for (const [criterion, direction, key] of [['changeRate', 'desc', 'change_desc'], ['changeRate', 'asc', 'change_asc'], ['turnover', 'asc', 'turnover_asc'], ['turnover', 'desc', 'turnover_desc']]) {
            await page.getByTestId(`market-sort-${criterion}`).click(); await page.getByTestId(`market-sort-${direction}`).click();
            await page.waitForTimeout(50); assert.deepEqual(await order(), LIST_ORDER[key], `${width}/${theme}/${fontScale} ${key}`);
          }
          // Search and sort stay apart and on screen; unavailable statistics never read as 0.
          const rects = await page.evaluate(() => ['[aria-label="선물 상품 검색"]', '[data-testid="market-sort-control"]', '[data-testid="futures-list-summary"]']
            .map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
          const meet = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
          assert.equal(meet(rects[0], rects[1]) || meet(rects[1], rects[2]) || meet(rects[0], rects[2]), false, 'search/sort/summary overlap');
          assert.equal(rects.every((r) => r[0] >= 0 && r[2] <= width), true, 'sort control on screen');
          assert.equal(await page.getByTestId('futures-change-stats-off').getByText(/0\.00%/).count(), 0, 'unavailable change is not 0%');
          // A price beside the name never squeezes the name column below its scaled basis.
          const squeezed = await page.$$eval('[data-testid^="futures-market-"]', (rows, scale) => rows.filter((row) => row.dataset.testid !== 'futures-market-list').flatMap((row) => {
            const [identity, value] = [...row.children].filter((child) => child.textContent.trim()).map((child) => child.getBoundingClientRect());
            return value && value.top < identity.bottom - 1 && identity.width < 110 * scale * 0.95 ? [row.dataset.testid] : [];
          }), fontScale);
          assert.deepEqual(squeezed, [], 'name column squeezed by a short price');
          await page.getByLabel('선물 상품 검색', { exact: true }).fill('example');
          assert.deepEqual(await order(), ['long'], 'search by name'); await page.getByLabel('선물 상품 검색', { exact: true }).fill('');
        } else {
          await page.getByTestId('futures-market-long').click(); await page.getByTestId('futures-screen').waitFor();
          assert.equal(await page.evaluate(() => window.fixture.state.instrumentId), 'long');
        }
      } else if (!futuresBundle) {
        await page.getByTestId('futures-screen').waitFor(); await page.getByTestId('futures-order-book-card').waitFor();
        if (scenario === 'chart') { await page.getByTestId('futures-chart-toggle').click(); await page.getByTestId('futures-candle-chart').waitFor(); await page.waitForTimeout(300); }
        if (scenario.startsWith('book')) {
          const status = { 'book-stale': '호가 정보가 지연되고 있습니다.', 'book-loading': '호가 정보를 불러오는 중입니다.', 'book-unavailable': '호가 정보를 현재 수신할 수 없습니다.' }[scenario];
          if (status) await page.getByTestId('futures-order-book-card').getByText(status, { exact: true }).waitFor();
          assert.equal(await page.getByTestId('asset-order-book-asks-10').count(), ['book', 'book-large', 'book-stale'].includes(scenario) ? 1 : 0);
          await page.getByTestId('futures-order-book-last').waitFor();
          if (scenario === 'book') {
            await page.getByTestId('futures-order-book-toggle').click(); assert.equal(await page.getByTestId('asset-order-book').count(), 0);
            await page.getByTestId('futures-order-book-toggle').click(); await page.getByTestId('asset-order-book-bids-10').waitFor();
          }
        }
        if (scenario === 'market-order') { await tab('숏(Short)'); await page.getByTestId('futures-leverage').fill('100'); await page.getByTestId('futures-quantity').fill('0.12345678'); }
        if (scenario === 'limit-order') { await pick('limit'); await tab('숏(Short)'); await tab('격리(Isolated)'); await page.getByTestId('futures-leverage').fill('100');
          await page.getByTestId('futures-quantity').fill('0.12345678'); await page.getByTestId('futures-limit-price').fill('1234567890123456.12345678'); }
        if (scenario.startsWith('conditional')) {
          await pick('conditional'); await page.getByTestId('futures-conditional-entry').waitFor();
          const long = scenario === 'conditional-error';
          await tab(long ? '롱(Long)' : '숏(Short)'); await tab(long ? '교차(Cross)' : '격리(Isolated)');
          await page.getByTestId('futures-leverage').fill('100'); await page.getByTestId('futures-quantity').fill('0.12345678');
          await page.getByTestId(`futures-conditional-trigger-${long ? 'at_or_above' : 'at_or_below'}`).click();
          await page.getByTestId('futures-conditional-trigger-price').fill(long ? '50' : '90.12345678');
          if (long) await page.getByTestId('futures-conditional-already-met').waitFor();
          else { await page.getByTestId('futures-conditional-execution-limit').click(); await page.getByTestId('futures-conditional-limit-price').fill('1234567890123456.12345678');
            await page.getByTestId('futures-conditional-summary').waitFor(); }
        }
        if (scenario === 'pending-conditional') { await page.getByTestId('futures-view-pending').click(); await page.getByTestId('pending-kind-conditional').click();
          await page.getByTestId('futures-conditional-watching').waitFor(); await page.getByTestId('futures-conditional-pending').waitFor();
          // Fees use the USD money display like the futures history.
          await page.getByText(/수수료 \$12,345,678,901\.12$/).first().waitFor(); }
      } else {
        await page.getByTestId('futures-trade').waitFor();
        if (scenario === 'refusal') await page.getByTestId('futures-mode-notice').waitFor();
        else {
          const id = 'A:position';
          await page.getByTestId(`futures-position-${id}-protection`).click(); await page.getByTestId('protection-panel').waitFor();
          // Cross positions never show an individual liquidation price.
          assert.equal(await page.getByTestId(`futures-position-${id}`).getByText('예상 청산가', { exact: true }).count(), scenario === 'position-cross' ? 0 : 1);
        }
      }
      await page.waitForTimeout(120);
      if (!results.length) await selfTest(page);
      const issues = await inspect(page);
      const label = `${width}-${theme}-${fontScale}-${scenario}`;
      if (issues.length) findings.push({ label, issues: issues.slice(0, 8), count: issues.length });
      results.push(label);
      if ((width === 320 && fontScale === 2) || (width === 360 && fontScale === 1 && theme === 'light')) {
        const height = await page.evaluate(() => Math.max(document.scrollingElement.scrollHeight, ...[...document.querySelectorAll('div')].map((d) => d.scrollHeight)));
        await page.setViewportSize({ width, height: Math.min(Math.max(height, 568), 6000) }); await page.waitForTimeout(80);
        await page.screenshot({ path: path.join(out, label + '.png') });
      }
    }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ layouts: results.length, findings, errors, scope: 'RN Web real screens; native iOS/Android not exercised' }, null, 2));
    assert.deepEqual(errors, []);
    assert.deepEqual(findings, [], `layout findings in ${findings.length} layouts (see ${out}/report.json)`);
    console.log(`Futures release browser PASS ${results.length} layouts`);
  } finally { await browser.close(); await new Promise((r) => server.close(r)); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
