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
    if (!process.argv.includes('--market-only')) {
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430])
      for (const fontScale of [1, 1.5, 2]) for (const mode of ['general', 'season']) {
        await page.setViewportSize({ width, height: 1100 });
        await page.emulateMedia({ colorScheme: appearance });
        await page.goto(`${base}/?screen=home&trend=1&long=1&mode=${mode}&fontScale=${fontScale}`);
        await id('home-total-asset').waitFor();
        assert.equal(await id('home-trend-chart').count(), 0);
        assert.equal(await id('home-trend-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(await page.evaluate(() => window.fixture.transport.equityRequests?.length ?? 0), 0);
        const icon = id('home-trend-disclosure');
        assert.equal(await icon.evaluate(el => getComputedStyle(el).borderTopWidth), '7px');
        const beforeToggle = await box('home-trend-toggle'), beforeHero = await box('home-summary-card'), beforeHoldings = await box('home-holdings');
        assert.ok(beforeToggle.y - beforeHero.y - beforeHero.height <= 5, 'Hero joins disclosure without section gap');
        assert.ok(beforeHoldings.y - beforeToggle.y - beforeToggle.height <= 5, 'compact disclosure joins holdings');
        await id('home-trend-toggle').click();
        assert.equal(await icon.evaluate(el => getComputedStyle(el).borderBottomWidth), '7px');
        await id('home-trend-chart').locator('svg').waitFor();
        const toggle = await box('home-trend-toggle'), chart = await box('home-trend-chart'), holdings = await box('home-holdings');
        assert.ok(chart.y >= toggle.y + toggle.height && holdings.y >= chart.y + chart.height);
        assert.equal(await id('home-competition').count(), 0);
        const context = await box('home-account-context'), hero = await box('home-summary-card');
        assert.ok(context.y + context.height <= hero.y);
        for (const period of ['7d', '30d', '90d', '180d', '360d']) {
          await id(`home-trend-range-${period}`).click();
          await page.waitForFunction(range => window.fixture.transport.equityRequests.some(request => request.range === range), period);
          await id('home-trend-chart').locator('svg').waitFor();
          assert.equal(await id(`home-trend-range-${period}`).getAttribute('aria-selected'), 'true');
          await page.waitForFunction(id => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().height >= 43.99, `home-trend-range-${period}`);
          await page.waitForFunction(() => ['7d', '30d', '90d', '180d', '360d'].every(period => {
            const element = document.querySelector(`[data-testid="home-trend-range-${period}"]`);
            const transform = getComputedStyle(element).transform;
            return transform === 'none' || transform === 'matrix(1, 0, 0, 1, 0, 0)';
          }));
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
        assert.equal(await icon.evaluate(el => getComputedStyle(el).borderTopWidth), '7px');
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
    }
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430])
      for (const fontScale of [1, 1.5, 2]) for (const financialPreference of ['red_blue', 'green_red']) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?screen=market&session=closed&long=1&fontScale=${fontScale}`);
      await id('market-sort-control').waitFor();
      await page.evaluate(preference => window.fixture.appearance.setFinancialPreference(preference), financialPreference);
      assert.equal(await id('market-sort-turnover').getAttribute('aria-checked'), 'true');
      assert.equal(await id('market-sort-desc').getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByText('새로고침', { exact: true }).count(), 0);
      for (const [criterion, direction] of [['turnover', 'asc'], ['changeRate', 'asc'], ['changeRate', 'desc'], ['turnover', 'desc']]) {
        await id(`market-sort-${criterion}`).click(); await id(`market-sort-${direction}`).click();
        await page.waitForFunction(({ criterion, direction }) => window.fixture.transport.requests.some(url => {
          const p = new URL(url, location.origin).searchParams;
          return p.get('sortBy') === criterion && p.get('sortOrder') === direction;
        }), { criterion, direction });
        assert.equal(await id(`market-sort-${criterion}`).getAttribute('aria-checked'), 'true');
        assert.equal(await id(`market-sort-${direction}`).getAttribute('aria-checked'), 'true');
      }
      await assertGlyphBounds('market-sort-control'); await assertGlyphBounds('market-session-summary');
      const asc = await box('market-sort-asc'), desc = await box('market-sort-desc');
      assert.ok(Math.abs(asc.y + asc.height - desc.y) < 0.1, 'direction targets share only a boundary');
      const visualUp = await box('market-sort-asc-triangle'), visualDown = await box('market-sort-desc-triangle');
      assert.ok(Math.abs(visualDown.y - visualUp.y - visualUp.height - 2) < 0.1);
      for (const direction of ['asc', 'desc', 'asc', 'desc']) {
        const button = id(`market-sort-${direction}`), b = await box(`market-sort-${direction}`);
        const visual = await box(`market-sort-${direction}-triangle`);
        assert.equal(visual.width, 10); assert.equal(visual.height, 7);
        assert.equal(b.width, 44); assert.equal(b.height, 24);
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.mouse.down(); await page.waitForTimeout(130);
        const held = await button.evaluate(el => {
          const s = getComputedStyle(el);
          return { background: s.backgroundColor, border: s.borderTopWidth, transform: s.transform,
            children: el.children.length };
        });
        assert.deepEqual(held, { background: 'rgba(0, 0, 0, 0)', border: '0px', transform: 'none', children: 1 });
        await page.mouse.up();
        assert.equal(await button.getAttribute('aria-checked'), 'true');
      }
      const borderColor = direction => id(`market-sort-${direction}-triangle`).evaluate((el, direction) =>
        getComputedStyle(el)[direction === 'asc' ? 'borderBottomColor' : 'borderTopColor'], direction);
      assert.notEqual(await borderColor('asc'), await borderColor('desc'));
      const originalColors = [await borderColor('asc'), await borderColor('desc')];
      await page.evaluate(preference => window.fixture.appearance.setFinancialPreference(preference === 'red_blue' ? 'green_red' : 'red_blue'), financialPreference);
      assert.deepEqual([await borderColor('asc'), await borderColor('desc')], originalColors, 'sort directions ignore financial colors');
      await page.evaluate(preference => window.fixture.appearance.setFinancialPreference(preference), financialPreference);
      await id('market-sort-asc').focus(); await page.keyboard.press('Enter');
      assert.equal(await id('market-sort-asc').getAttribute('aria-checked'), 'true');
      await id('market-sort-desc').click();
      for (const [assetType, tabId] of [['domestic_stock', 'domestic'], ['us_stock', 'us'], ['crypto', 'crypto']]) {
        await id(`market-tab-${tabId}`).click();
        await page.waitForFunction(type => window.fixture.transport.requests.some(url => new URL(url, location.origin).searchParams.get('assetType') === type), assetType);
        await id('market-item-asset-0').waitFor();
        await assertGlyphBounds('market-session-summary');
        await assertGlyphBounds('market-sort-control');
        await assertGlyphBounds('market-item-asset-0');
        assert.match(await id('market-session-summary').textContent(), assetType === 'crypto' ? /24시간 거래/ : /휴장 · 거래 종료/);
      }
      assert.equal(await page.getByText(/가격 기준/).count(), 0);
      assert.match(await id('market-session-summary').textContent(), /24시간 거래/);
      if (fontScale === 1) await page.screenshot({ path: path.join(out, `sort-${appearance}-${width}-${financialPreference}.png`) });
      await page.evaluate(() => {
        const q = window.fixture.client.getQueryCache().findAll().find(q => q.queryKey[0] === 'market' && q.queryKey.includes('crypto'));
        window.fixture.firstSortSnapshot = q.state.data.pages[0].sortSnapshot;
      });
      await id('market-item-asset-19').scrollIntoViewIfNeeded(); await id('market-item-asset-20').waitFor();
      const next = await page.evaluate(() => window.fixture.transport.requests.find(p => p.includes('assetType=crypto') && p.includes('offset=20')));
      assert.equal(new URL(next, base).searchParams.get('sortSnapshot'), await page.evaluate(() => window.fixture.firstSortSnapshot));
      await theme.canvas(page, appearance);
      records.push({ screen: 'market', appearance, width, fontScale, financialPreference, markets: ['domestic_stock', 'us_stock', 'crypto'], sorts: 4, pagination: true });
    }
    await page.goto(`${base}/?screen=search`);
    await id('market-search-input').fill('삼성'); await id('market-sort-control').waitFor();
    await id('market-sort-changeRate').click(); await id('market-sort-asc').click();
    await page.waitForFunction(() => window.fixture.transport.requests.some(p => p.includes('sortBy=changeRate') && p.includes('sortOrder=asc')));
    const search = await page.evaluate(() => window.fixture.transport.requests.filter(p => p.includes('sortBy=changeRate')).at(-1));
    assert.equal(new URL(search, base).searchParams.get('search'), '삼성');
    assert.equal(new URL(search, base).searchParams.get('sortOrder'), 'asc');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'PASS', records, errors }, null, 2));
    console.log(`PASS ${records.length} Home/Market layouts, five ranges, tooltip bounds, account switching, server sort queries/search/pagination`);
  } finally { await browser.close(); server.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
