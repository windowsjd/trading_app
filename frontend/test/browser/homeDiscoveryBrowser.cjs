// Real Home + Market + navigation, Query and appearance; only transport is a fixture.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..'), out = process.env.HOME_DISCOVERY_BROWSER_OUTPUT ?? '/tmp/trading-home-discovery-browser';
const palette = {
  light: { red_blue: ['rgb(161, 62, 59)', 'rgb(49, 95, 155)'], green_red: ['rgb(22, 128, 58)', 'rgb(161, 62, 59)'] },
  dark: { red_blue: ['rgb(255, 139, 134)', 'rgb(140, 186, 255)'], green_red: ['rgb(121, 214, 139)', 'rgb(255, 139, 134)'] },
};
async function run() {
  fs.mkdirSync(out, { recursive: true });
  for (const fixture of ['rootTabs', 'walletNavigation']) await esbuild.build({
    entryPoints: [path.join(__dirname, `${fixture}Fixture.jsx`)], outfile: path.join(out, `${fixture}.js`),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'rootTabsMocks.js') }));
      if (fixture === 'rootTabs') b.onResolve({ filter: /navigationHooks$/ }, () => ({ path: path.join(__dirname, 'rootTabsMocks.js') }));
      if (fixture === 'walletNavigation') b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.match(/^\/(rootTabs|walletNavigation)\.js/);
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, `${script[1]}.js`)) : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/${req.url.startsWith('/navigation') ? 'walletNavigation' : 'rootTabs'}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(), records = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const p = new URLSearchParams(location.search);
    localStorage.setItem('selectedTradingAccountId:home-user', `${p.get('mode') ?? 'season'}-account`);
    localStorage.setItem('trading-app:appearance', 'system');
    localStorage.setItem('trading-app:financial-colors', p.get('palette') ?? 'red_blue');
  });
  const id = name => page.getByTestId(name), rows = () => page.locator('[data-testid^="home-position-item-"][role="button"]');
  const color = locator => locator.evaluate(el => getComputedStyle(el).color);
  const bounds = async name => {
    const clipped = await id(name).evaluate(el => {
      const box = el.getBoundingClientRect(), failures = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        for (let i = 0; i < node.textContent.length; i++) {
          if (!node.textContent[i].trim()) continue;
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          for (const r of range.getClientRects()) if (r.width && (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1)) failures.push(node.textContent);
        }
      }
      return failures;
    });
    assert.deepEqual(clipped, [], `${name} clips text`);
  };
  try {
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430])
      for (const fontScale of [1, 1.5, 2]) for (const mode of ['general', 'season']) for (const preference of ['red_blue', 'green_red']) {
        await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: appearance });
        await page.goto(`${base}/?screen=home&mode=${mode}&holdings=1&long=1&hugePrice=1&fontScale=${fontScale}&palette=${preference}`);
        await id('home-total-asset').waitFor(); await id('home-hot-item-asset-4').waitFor();
        assert.equal(await id('home-competition').count(), 0);
        assert.equal(await id('home-rank').count(), mode === 'season' ? 1 : 0);
        assert.ok(await id('home-account-context').locator('[data-testid=home-nickname]').count());
        assert.equal(await rows().count(), 1);
        assert.equal(await id('home-hot-tab-domestic_stock').getAttribute('aria-selected'), 'true');
        assert.equal(await id('home-holdings-toggle').getAttribute('aria-expanded'), 'false');
        for (const name of ['home-account-context', 'home-holdings', 'home-hot']) await bounds(name);
        const holdings = await id('home-holdings').boundingBox(), hot = await id('home-hot').boundingBox();
        assert.ok(hot.y >= holdings.y + holdings.height);
        await theme.background(id('home-account-context'), appearance, 'surface');
        await theme.background(id('home-hot'), appearance, 'surface');
        assert.equal(await color(id(`home-position-item-${mode}-account-asset-0-return`)), palette[appearance][preference][0]);
        assert.equal(await color(id('home-hot-change-asset-0')), palette[appearance][preference][0]);
        assert.equal(await color(id('home-hot-change-asset-1')), palette[appearance][preference][1]);
        assert.equal(await id('home-hot-change-asset-2').textContent(), '0%');
        assert.equal(await id('home-hot-change-asset-3').textContent(), '-');
        for (const type of ['domestic_stock', 'us_stock', 'crypto']) {
          await id(`home-hot-tab-${type}`).click();
          await page.waitForFunction(type => window.fixture.transport.requests.some(url => url.startsWith('/assets?') && new URL(url, location.origin).searchParams.get('assetType') === type), type);
          assert.equal(await id(`home-hot-tab-${type}`).getAttribute('aria-selected'), 'true');
          for (const category of ['domestic_stock', 'us_stock', 'crypto']) {
            const tab = id(`home-hot-tab-${category}`);
            assert.equal(await tab.getAttribute('role'), 'tab');
            assert.equal(await tab.getAttribute('aria-selected'), String(category === type));
            assert.equal(await tab.evaluate(el => getComputedStyle(el).backgroundColor), category === type
              ? appearance === 'light' ? 'rgb(234, 244, 252)' : 'rgb(28, 48, 66)' : 'rgba(0, 0, 0, 0)');
            assert.equal(await tab.locator('[dir="auto"]').evaluate(el => getComputedStyle(el).color), category === type
              ? appearance === 'light' ? 'rgb(40, 91, 133)' : 'rgb(185, 221, 252)' : theme.palettes[appearance].secondary);
          }
          const market = id('home-hot-market');
          assert.equal(await color(market.locator('[dir="auto"]')), 'rgb(255, 255, 255)');
          assert.deepEqual(await market.locator('linearGradient stop').evaluateAll(nodes => nodes.map(node => node.getAttribute('stop-color'))), ['#326FE5', '#7447D8']);
          assert.deepEqual(await market.locator('linearGradient').evaluate(el => ['x1', 'y1', 'x2', 'y2'].map(key => el.getAttribute(key))), ['0%', '50%', '100%', '50%']);
          assert.deepEqual(await market.evaluate(el => {
            const css = getComputedStyle(el); return [css.minHeight, css.paddingTop, css.paddingBottom];
          }), ['44px', '8px', '8px']);
          const request = await page.evaluate(type => window.fixture.transport.requests.filter(url => url.startsWith('/assets?') && new URL(url, location.origin).searchParams.get('assetType') === type).at(-1), type);
          const p = new URL(request, base).searchParams;
          assert.equal(p.get('sortBy'), 'turnover'); assert.equal(p.get('sortOrder'), 'desc'); assert.equal(p.get('limit'), '5');
          await bounds('home-hot');
        }
        await id('home-holdings-toggle').click(); await id(`home-position-item-${mode}-account-asset-6`).waitFor();
        assert.equal(await rows().count(), 7);
        await bounds('home-holdings');
        await id('home-holdings-toggle').click(); assert.equal(await rows().count(), 1);
        if (width === 390 && fontScale === 1 && preference === 'red_blue') {
          await id('home-account-context').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(out, `${mode}-${appearance}.png`), fullPage: true });
        }
        records.push({ appearance, width, fontScale, mode, preference });
      }
    for (const appearance of ['light', 'dark']) for (const mode of ['general', 'season']) {
      await page.setViewportSize({ width: 390, height: 1000 }); await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?screen=home&mode=${mode}&holdings=1`);
      await id('home-hot-item-asset-4').waitFor();
      await page.screenshot({ path: path.join(out, `${mode}-${appearance}-normal.png`) });
      await id('home-hot').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `${mode}-${appearance}-hot.png`) });
    }
    await page.goto(`${base}/?screen=home&holdings=1&many=1`);
    await id('home-holdings-toggle').click(); await id('home-position-item-season-account-asset-206').waitFor();
    assert.equal(await rows().count(), 207);
    await id('home-hot-tab-us_stock').click();
    await id('trading-account-switcher-trigger').click(); await id('trading-account-switcher-option-general-account').click();
    await id('home-position-item-general-account-asset-0').waitFor();
    assert.equal(await rows().count(), 1);
    assert.equal(await id('home-hot-tab-us_stock').getAttribute('aria-selected'), 'true');
    assert.equal(await id('home-rank').count(), 0);
    // Real nested navigator: consume category on initial and repeat visits, then
    // preserve manual selection until the next explicit Home intent.
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(`${base}/navigation?navigation=1&holdings=1`);
    await id('home-hot-market').waitFor();
    for (const type of ['domestic_stock', 'us_stock', 'crypto', 'us_stock']) {
      await id(`home-hot-tab-${type}`).click(); await id('home-hot-market').click();
      await id('market-sort-control').waitFor();
      await page.waitForFunction(type => window.fixture.client.getQueryCache().findAll().some(q => q.isActive() && q.queryKey[0] === 'market' && q.queryKey.includes(type) && q.queryKey.includes(20)), type);
      const snapshot = await page.evaluate(type => {
        const queries = window.fixture.client.getQueryCache().findAll();
        const hot = queries.find(q => q.queryKey[0] === 'market' && q.queryKey.includes(type) && q.queryKey.includes('preview')).state.data;
        const market = queries.find(q => q.queryKey[0] === 'market' && q.queryKey.includes(type) && q.queryKey.includes(20)).state.data.pages[0];
        return { hotToken: hot.sortSnapshot, marketToken: market.sortSnapshot, hot: hot.assets.map(a => a.id), market: market.assets.slice(0, 5).map(a => a.id) };
      }, type);
      assert.equal(snapshot.hotToken, snapshot.marketToken); assert.deepEqual(snapshot.hot, snapshot.market);
      await id('market-tab-domestic').click();
      await page.evaluate(() => window.fixture.navigationRef.navigate('MainTabs', { screen: 'HomeTab', params: { screen: 'Home' } }));
      await id('home-hot-market').waitFor();
    }
    await id('home-hot-item-asset-0').click();
    await page.waitForFunction(() => window.fixture.navigationRef.getCurrentRoute()?.name === 'AssetDetail');
    assert.equal(await page.evaluate(() => window.fixture.navigationRef.getCurrentRoute().params.assetId), 'asset-0');
    // Shared fixture checked by AssetsService against actual ingestion output.
    await page.goto(`${base}/navigation?navigation=1&holdings=1&cryptoContract=1`);
    await id('home-hot-tab-crypto').click();
    await id('home-hot-item-BTCUSDT').waitFor();
    assert.deepEqual(await page.locator('[data-testid^="home-hot-item-"][role="button"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid)),
      ['ETHUSDT', 'ADAUSDT', 'XRPUSDT', 'SOLUSDT', 'BTCUSDT'].map(id => `home-hot-item-${id}`));
    assert.ok(!(await id('home-hot').textContent()).includes('거래대금을 확인할 수 있는 종목이 없습니다.'));
    await id('home-hot-market').click(); await id('market-sort-control').waitFor();
    await page.waitForFunction(() => window.fixture.client.getQueryCache().findAll().some(q => q.isActive() && q.queryKey.includes('crypto') && q.queryKey.includes(20) && q.state.data));
    const crypto = await page.evaluate(() => {
      const queries = window.fixture.client.getQueryCache().findAll();
      const hot = queries.find(q => q.queryKey.includes('crypto') && q.queryKey.includes('preview')).state.data;
      const market = queries.find(q => q.queryKey.includes('crypto') && q.queryKey.includes(20)).state.data.pages[0];
      return { hotToken: hot.sortSnapshot, marketToken: market.sortSnapshot, hot: hot.assets.map(a => a.id), market: market.assets.slice(0, 5).map(a => a.id) };
    });
    assert.equal(crypto.hotToken, crypto.marketToken); assert.deepEqual(crypto.hot, crypto.market);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ status: 'PASS', layouts: records, interactions: ['207 holdings', 'account switch', 'all categories', 'repeat Market intent', 'AssetDetail'], errors }, null, 2));
    console.log(`PASS ${records.length} Home layouts, holdings pagination, palettes, account and real Market navigation`);
  } finally { await browser.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
