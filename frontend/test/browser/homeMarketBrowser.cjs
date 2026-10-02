// Real Home/Market screens, Query, date geometry, gestures and theme. HTTP only is fixture data.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.HOME_MARKET_BROWSER_OUTPUT ?? '/tmp/trading-home-market-browser';
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'rootTabsFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true,
    platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'rootTabsMocks.js') }));
    } }], logLevel: 'warning',
  });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  const server = http.createServer((req, res) => {
    const js = req.url.startsWith('/bundle.js'); res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(out, js ? 'bundle.js' : 'index.html')));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [], records = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const p = new URLSearchParams(location.search);
    localStorage.setItem('selectedTradingAccountId:home-user', `${p.get('mode') ?? 'season'}-account`);
    localStorage.setItem('trading-app:appearance', 'system');
  });
  const id = name => page.getByTestId(name);
  const box = name => id(name).boundingBox();
  const assertGlyphBounds = async (name) => {
    const clipped = await id(name).evaluate(el => {
      const b = el.getBoundingClientRect(), clipped = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const r = document.createRange(); r.selectNodeContents(walker.currentNode);
        for (const rect of r.getClientRects()) if (rect.width && (rect.left < b.left - 1 || rect.right > b.right + 1 || rect.top < b.top - 1 || rect.bottom > b.bottom + 1)) clipped.push(walker.currentNode.textContent);
      }
      return clipped;
    });
    assert.deepEqual(clipped, [], `${name} glyph clipping`);
  };
  try {
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430])
      for (const fontScale of [1, 2]) for (const mode of ['general', 'season']) {
        await page.setViewportSize({ width, height: 1100 });
        await page.emulateMedia({ colorScheme: appearance });
        await page.goto(`${base}/?screen=home&trend=1&long=1&mode=${mode}&fontScale=${fontScale}`);
        await id('home-total-asset').waitFor();
        assert.equal(await id('home-trend-chart').count(), 0);
        assert.equal(await id('home-trend-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(await page.evaluate(() => window.fixture.transport.equityRequests?.length ?? 0), 0);
        await id('home-trend-toggle').click();
        await id('home-trend-chart').locator('svg').waitFor();
        const toggle = await box('home-trend-toggle'), chart = await box('home-trend-chart'), holdings = await box('home-holdings');
        assert.ok(chart.y >= toggle.y + toggle.height && holdings.y >= chart.y + chart.height);
        if (mode === 'season') {
          const competition = await box('home-competition');
          assert.ok(competition.y >= chart.y + chart.height && competition.y < holdings.y);
        } else assert.equal(await id('home-competition').count(), 0);
        for (const period of ['7d', '30d', '90d', '180d', '360d']) {
          await id(`home-trend-range-${period}`).click();
          await page.waitForFunction(range => window.fixture.transport.equityRequests.some(request => request.range === range), period);
          await id('home-trend-chart').locator('svg').waitFor();
          assert.equal(await id(`home-trend-range-${period}`).getAttribute('aria-selected'), 'true');
          await page.waitForFunction(id => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().height >= 43.99, `home-trend-range-${period}`);
          for (const p of ['7d', '30d', '90d', '180d', '360d']) {
            const b = await box(`home-trend-range-${p}`);
            assert.ok(b.x >= 0 && b.x + b.width <= width && b.height >= 43.99, JSON.stringify({ p, b, width, fontScale }));
          }
          const text = await id('home-trend-chart').textContent();
          assert.doesNotMatch(text, /최근 30일 ·|최신 값|선택 값/);
        }
        const svg = id('home-trend-chart').locator('svg');
        await svg.scrollIntoViewIfNeeded();
        const bounds = await svg.boundingBox();
        for (const ratio of [0, 0.5, 1]) {
          await page.mouse.move(bounds.x + 12 + ratio * (bounds.width - 24), bounds.y + bounds.height / 2);
          await id('line-chart-tooltip').waitFor();
          const tip = await box('line-chart-tooltip');
          assert.ok(tip.x >= bounds.x && tip.x + tip.width <= bounds.x + bounds.width + 1);
          assert.ok(tip.y >= bounds.y && tip.y + tip.height <= bounds.y + bounds.height + 1);
          const content = await id('line-chart-tooltip').textContent();
          assert.match(content, /2026-\d{2}-\d{2}/); assert.match(content, /1,234,567,890,123,4\d{2}원/);
          await assertGlyphBounds('line-chart-tooltip');
        }
        await theme.canvas(page, appearance);
        await theme.background(id('line-chart-tooltip'), appearance, 'raised');
        await assertGlyphBounds('home-trend-chart');
        if (fontScale === 1) await page.screenshot({ path: path.join(out, `trend-${mode}-${appearance}-${width}.png`), fullPage: true });
        await page.mouse.move(0, 0);
        await id('home-trend-toggle').click();
        assert.equal(await id('home-trend-chart').count(), 0);
        records.push({ screen: 'home', mode, appearance, width, fontScale, periods: 5, tooltipPositions: 3 });
      }
    // Active range request for the outgoing account cannot appear in the incoming account.
    await page.goto(`${base}/?screen=home&trend=1&mode=season`);
    await id('home-total-asset').waitFor();
    await page.evaluate(() => { window.fixture.transport.trendDelay = 'season-account'; });
    await id('home-trend-toggle').click();
    await id('trading-account-switcher-trigger').click();
    await id('trading-account-switcher-option-general-account').click();
    await id('trading-account-general-summary').waitFor();
    await page.evaluate(() => { window.fixture.transport.trendDelay = null; window.fixture.transport.release(); });
    assert.equal(await id('home-trend-chart').count(), 0);
    await id('home-trend-toggle').click();
    await id('home-trend-chart').locator('svg').waitFor();
    assert.equal(await id('home-trend-range-30d').getAttribute('aria-selected'), 'true');
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?screen=market`);
      await id('market-sort-trigger').waitFor();
      assert.match(await id('market-sort-trigger').textContent(), /거래량/);
      for (const sort of ['change_desc', 'change_asc', 'volume_desc']) {
        await id('market-sort-trigger').click(); await id(`market-sort-${sort}`).click();
        await id('market-sort-trigger').waitFor();
        const urls = await page.evaluate(() => window.fixture.transport.requests.filter(p => p.startsWith('/assets?')));
        assert.ok(urls.some(url => {
          const request = new URL(url, base);
          return request.searchParams.get('sortBy') === (sort === 'volume_desc' ? 'volume' : 'changeRate') &&
            request.searchParams.get('sortOrder') === (sort === 'change_asc' ? 'asc' : 'desc');
        }));
        assert.match(await id('market-sort-trigger').textContent(), sort === 'volume_desc' ? /거래량/ : sort === 'change_asc' ? /낮은순/ : /높은순/);
      }
      await id('market-tab-crypto').click(); await id('market-sort-trigger').waitFor();
      assert.match(await id('market-sort-trigger').textContent(), /24h/);
      await id('market-sort-trigger').click();
      await page.getByText(/코인마다 단위가 달라/).waitFor();
      await page.screenshot({ path: path.join(out, `sort-${appearance}-${width}.png`) });
      await page.getByText('닫기', { exact: true }).click();
      await page.evaluate(() => {
        const q = window.fixture.client.getQueryCache().findAll().find(q => q.queryKey[0] === 'market' && q.queryKey.includes('crypto'));
        const page = q.state.data.pages[0];
        window.fixture.firstSortSnapshot = page.sortSnapshot;
      });
      await id('market-item-asset-19').scrollIntoViewIfNeeded();
      await id('market-item-asset-20').waitFor();
      const next = await page.evaluate(() => window.fixture.transport.requests.find(p => p.includes('assetType=crypto') && p.includes('offset=20')));
      assert.equal(new URL(next, base).searchParams.get('sortSnapshot'), await page.evaluate(() => window.fixture.firstSortSnapshot));
      await theme.canvas(page, appearance);
      records.push({ screen: 'market', appearance, width, sorts: 3, pagination: true });
    }
    await page.goto(`${base}/?screen=search`);
    await id('market-search-input').fill('삼성'); await id('market-sort-trigger').waitFor();
    await id('market-sort-trigger').click(); await id('market-sort-change_asc').click();
    await id('market-sort-trigger').waitFor();
    const search = await page.evaluate(() => window.fixture.transport.requests.filter(p => p.includes('sortBy=changeRate')).at(-1));
    assert.equal(new URL(search, base).searchParams.get('search'), '삼성');
    assert.equal(new URL(search, base).searchParams.get('sortOrder'), 'asc');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'PASS', records, errors }, null, 2));
    console.log(`PASS ${records.length} Home/Market layouts, five ranges, tooltip bounds, account switching, server sort queries/search/pagination`);
  } finally { await browser.close(); server.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
