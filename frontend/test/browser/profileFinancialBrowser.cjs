// Production screens/providers/renderers; existing REST, WS and navigation fixture boundaries.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.PROFILE_FINANCIAL_BROWSER_OUTPUT ?? '/tmp/trading-profile-financial-browser';
const expected = {
  light: { red_blue: ['rgb(161, 62, 59)', 'rgb(49, 95, 155)'], green_red: ['rgb(22, 128, 58)', 'rgb(161, 62, 59)'] },
  dark: { red_blue: ['rgb(255, 139, 134)', 'rgb(140, 186, 255)'], green_red: ['rgb(121, 214, 139)', 'rgb(255, 139, 134)'] },
};
const actions = {
  red_blue: ['rgb(209, 17, 11)', 'rgb(10, 90, 194)'],
  green_red: ['rgb(22, 128, 58)', 'rgb(209, 17, 11)'],
};
const candleColors = (appearance, palette) => palette === 'red_blue'
  ? actions.red_blue : [expected[appearance].green_red[0], actions.green_red[1]];
const surfaces = {
  light: { red_blue: ['rgb(254, 242, 242)', 'rgb(239, 246, 255)'], green_red: ['rgb(240, 253, 244)', 'rgb(254, 242, 242)'] },
  dark: { red_blue: ['rgb(56, 35, 42)', 'rgb(30, 48, 75)'], green_red: ['rgb(29, 57, 43)', 'rgb(56, 35, 42)'] },
};
const anchors = { home: 'home-total-asset', ranking: 'ranking-item-user-0', my: 'my-profile-avatar', market: 'market-item-asset-0', search: 'market-item-asset-0', settings: 'settings-financial-red_blue' };
async function run() {
  fs.mkdirSync(out, { recursive: true });
  for (const fixture of ['rootTabs', 'trading']) {
    await esbuild.build({
      entryPoints: [path.join(__dirname, `${fixture}Fixture.jsx`)], outfile: path.join(out, `${fixture}.js`),
      bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
      resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
      define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
      plugins: [{ name: 'existing-fixtures', setup(b) {
        b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
        if (fixture === 'trading') {
          b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
          b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
        } else {
          b.onResolve({ filter: /(services\/api\/client|navigationHooks|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'rootTabsMocks.js') }));
        }
      } }], logLevel: 'warning',
    });
  }
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/avatar.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#536170"/><circle cx="32" cy="30" r="16" fill="#fcfcfd"/></svg>');
    }
    if (req.url.startsWith('/missing-avatar')) { res.statusCode = 404; return res.end(); }
    if (/^\/(rootTabs|trading)\.js/.test(req.url)) {
      res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(out, req.url.split('?')[0])));
    }
    const fixture = req.url.startsWith('/trading') ? 'trading' : 'rootTabs';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/${fixture}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [], records = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const params = new URLSearchParams(location.search);
    localStorage.setItem('trading-app:appearance', 'system');
    localStorage.setItem('selectedTradingAccountId:home-user', params.get('account') ?? 'season-account');
    if (params.has('palette')) localStorage.setItem('trading-app:financial-colors', params.get('palette'));
  });
  const id = (value) => page.getByTestId(value);
  const color = (locator, property = 'color') => locator.evaluate((el, property) => getComputedStyle(el)[property], property);
  async function strongButton(locator, background) {
    assert.equal(await color(locator, 'backgroundColor'), background);
    assert.equal(await color(locator.locator('[dir="auto"]').first()), 'rgb(255, 255, 255)');
    const clipped = await locator.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const failures = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        if ([...range.getClientRects()].some((r) => r.width && (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1))) failures.push(node.textContent);
      }
      return failures;
    });
    assert.deepEqual(clipped, [], `strong button label bounds: ${await locator.getAttribute('data-testid')}`);
  }
  const open = async (screen, query = '', fixture = 'rootTabs') => {
    await page.goto(`${base}/${fixture}?screen=${screen}${query}`);
    if (screen === 'search') await id('market-search-input').fill('삼성');
    if (screen === 'home' && query.includes('general-account')) await id('home-total-asset').waitFor();
    else if (anchors[screen]) await id(anchors[screen]).waitFor();
  };
  async function readable(screen) {
    const failures = await page.evaluate((screen) => {
      const ids = { home: ['home-account-context', 'home-summary-card'], ranking: ['ranking-item-user-0'], my: ['my-screen'], market: ['market-item-asset-0', 'market-session-summary'], search: ['market-item-asset-0'], settings: ['settings-screen'] }[screen];
      const sections = ids.map((id) => document.querySelector(`[data-testid="${id}"]`)).filter(Boolean);
      if (screen === 'ranking') {
        const label = [...document.querySelectorAll('div')].find((el) => el.textContent === '상위 랭커');
        if (label) sections.push(label.parentElement);
      }
      const errors = [];
      for (const section of sections) {
        const boundary = section.getBoundingClientRect();
        const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.width && (r.left < boundary.left - 1 || r.right > boundary.right + 1 || r.left < -1 || r.right > innerWidth + 1)) errors.push(node.textContent);
        }
      }
      return errors;
    }, screen);
    assert.deepEqual(failures, [], `${screen} text bounds: ${page.url()}`);
  }
  try {
    for (const appearance of ['light', 'dark']) for (const palette of ['red_blue', 'green_red'])
      for (const width of (process.env.PROFILE_FINANCIAL_QUICK ? [320] : [320, 360, 390, 430])) for (const fontScale of (process.env.PROFILE_FINANCIAL_QUICK ? [2] : [1, 1.5, 2])) {
        await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
        const query = `&palette=${palette}&fontScale=${fontScale}&long=1&hugeRank=1&session=closed`;
        for (const screen of Object.keys(anchors)) {
          await open(screen, query); await theme.canvas(page, appearance); await readable(screen);
          if (screen === 'market' || screen === 'search') {
            assert.equal(await id('market-change-asset-0').innerText(), '+1.25%');
            assert.equal(await color(id('market-change-asset-0')), expected[appearance][palette][0]);
            assert.equal(await color(id('market-change-asset-1')), expected[appearance][palette][1]);
            assert.equal(await id('market-change-asset-2').innerText(), '0%');
            assert.equal(await color(id('market-change-asset-2')), appearance === 'light' ? 'rgb(83, 97, 112)' : 'rgb(197, 208, 218)');
            assert.equal(await id('market-change-asset-3').innerText(), '-');
            assert.doesNotMatch(await id('market-item-asset-0').innerText(), /closed|거래 제한|시장이 닫혀|거래 가능/);
            if (screen === 'market') assert.equal(await id('market-session-summary').innerText(), '휴장 · 거래 종료');
            else assert.equal(await id('market-session-summary').count(), 0);
          }
          if (screen === 'home') {
            await theme.background(id('trading-account-season-summary'), appearance, 'screen');
            await id('home-profile-avatar-fallback').waitFor();
            await theme.background(id('home-profile-avatar'), appearance, 'raised');
            assert.equal(await color(id('home-profile-avatar-fallback').locator('div').first(), 'backgroundColor'), appearance === 'light' ? 'rgb(105, 117, 131)' : 'rgb(174, 187, 200)');
            assert.equal(await color(id('home-summary-card').getByText('-3.52%', { exact: true })), expected[appearance][palette][1]);
          }
          if (screen === 'market' || screen === 'settings') await theme.background(id(`${screen}-screen`), appearance, 'screen');
          records.push({ screen, appearance, palette, width, fontScale });
          if (width === 390 && fontScale === 1) await page.screenshot({ path: path.join(out, `${screen}-${appearance}-${palette}.png`) });
        }
      }
    // Valid remote image and load failure use actual browser image decoding in every identity surface.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const profile of ['valid', 'broken']) for (const screen of ['home', 'ranking', 'my']) {
      await open(screen, `&profile=${profile}`);
      const avatar = { home: 'home-profile-avatar', ranking: 'ranking-avatar-user-0', my: 'my-profile-avatar' }[screen];
      if (profile === 'valid') await page.waitForFunction((avatar) => {
        const img = document.querySelector(`[data-testid="${avatar}-image"] img`);
        return img?.complete && img.naturalWidth > 0;
      }, avatar);
      else await id(`${avatar}-fallback`).waitFor();
      const size = await id(avatar).boundingBox(); assert.equal(size.width, screen === 'my' ? 64 : screen === 'home' ? 36 : 28);
    }
    await open('home', '&account=general-account&palette=green_red');
    assert.equal(await id('home-competition').count(), 0);
    assert.match(await id('home-summary-card').innerText(), /시간가중 수익률/);
    assert.equal(await color(page.getByText('4.82%', { exact: true })), expected.dark.green_red[0]);
    for (const width of [320,360,390,430]) {
      await page.setViewportSize({ width, height: 844 });
      await open('market', '&session=open&hugePrice=1&long=1&fontScale=2'); await readable('market');
    }
    assert.equal(await id('market-session-summary').innerText(), '정규장 · 거래 중');
    await id('market-tab-crypto').click();
    await page.getByText('24시간 거래', { exact: true }).waitFor();
    await id('market-tab-us').click();
    await page.getByText('정규장 · 거래 중', { exact: true }).waitFor();
    await open('market', '&session=unknown');
    assert.equal(await id('market-session-summary').innerText(), '시장 상태 확인 불가');
    assert.match(await id('market-item-asset-0').innerText(), /시장 상태 확인 불가/);
    assert.equal(await id('market-change-asset-0').innerText(), '+1.25%');
    // Settings updates mounted theme consumers and survives reload; appearance is independent.
    await open('settings', '&palette=red_blue');
    await id('settings-financial-green_red').click();
    await page.waitForFunction(() => localStorage.getItem('trading-app:financial-colors') === 'green_red');
    await page.evaluate(() => window.fixture.setScreen('home')); await id('home-total-asset').waitFor();
    assert.equal(await color(id('home-summary-card').getByText('-3.52%', { exact: true })), expected.dark.green_red[1]);
    await page.goto(`${base}/rootTabs?screen=settings`); await id('settings-financial-green_red').waitFor();
    assert.equal(await id('settings-financial-green_red').getAttribute('aria-checked'), 'true');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => window.fixture.setScreen('market')); await id('market-item-asset-0').waitFor();
    assert.equal(await color(id('market-change-asset-0')), expected.light.green_red[0]);
    await page.evaluate(() => window.fixture.setScreen('settings')); await id('settings-financial-red_blue').click();
    await page.evaluate(() => window.fixture.setScreen('market')); await id('market-item-asset-0').waitFor();
    assert.equal(await color(id('market-change-asset-0')), expected.light.red_blue[0]);
    await page.evaluate(() => { window.sameMarketRow = document.querySelector('[data-testid=market-item-asset-0]'); window.fixture.appearance.setFinancialPreference('green_red'); });
    await page.waitForFunction((color) => getComputedStyle(document.querySelector('[data-testid=market-change-asset-0]')).color === color, expected.light.green_red[0]);
    assert.ok(await page.evaluate(() => window.sameMarketRow === document.querySelector('[data-testid=market-item-asset-0]')), 'memoized rows repaint without remount');

    // Actual detail/order/chart renderers, order-book surfaces and memoized SVG repaint.
    for (const appearance of ['light', 'dark']) for (const palette of ['red_blue', 'green_red']) for (const width of [320,360,390,430]) for (const fontScale of [1, 1.5, 2]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
      await open('detail', `&asset=SUI&mixedCandles=1&palette=${palette}&fontScale=${fontScale}`, 'trading'); await id('asset-detail-name').waitFor();
      await theme.canvas(page, appearance);
      await theme.background(id('asset-detail-screen'), appearance, 'screen');
      await theme.background(id('asset-order-actions'), appearance, 'surface');
      const up = expected[appearance][palette][0], down = expected[appearance][palette][1];
      assert.equal(await color(id('asset-change-rate')), up);
      const expectedAction = actions[palette];
      await strongButton(id('asset-detail-open-buy-order'), expectedAction[0]);
      await strongButton(id('asset-detail-open-sell-order'), expectedAction[1]);
      const candles = await page.locator('svg g[clip-path] > g').evaluateAll((els) => els.map((el) => ({
        body: getComputedStyle(el.querySelector('rect')).fill,
        wick: getComputedStyle(el.querySelector('line')).stroke,
      })));
      const expectedCandles = candleColors(appearance, palette);
      assert.ok(expectedCandles.every((fill) => candles.some((candle) => candle.body === fill)), `candle directions ${appearance} ${palette}`);
      for (const candle of candles) {
        assert.ok(expectedCandles.includes(candle.body));
        assert.equal(candle.wick, candle.body);
      }
      const currentLine = page.locator('svg line[stroke-dasharray="3 3"]');
      assert.equal(await color(currentLine, 'stroke'), expectedCandles[1], 'latest mixed candle is bearish');
      assert.equal(await color(currentLine.locator('..').locator('rect'), 'fill'), expectedCandles[1]);
      if (width === 390 && fontScale === 1) await page.screenshot({ path: path.join(out, `detail-${appearance}-${palette}.png`) });
      await page.evaluate(() => window.tradingAppearance.setFinancialPreference(window.tradingAppearance.financialPreference === 'red_blue' ? 'green_red' : 'red_blue'));
      const other = palette === 'red_blue' ? 'green_red' : 'red_blue';
      await page.waitForFunction((fill) => [...document.querySelectorAll('svg g[clip-path] rect')].some((el) => getComputedStyle(el).fill === fill), candleColors(appearance, other)[0]);
      await page.evaluate((palette) => window.tradingAppearance.setFinancialPreference(palette), palette);
      await id('asset-detail-open-buy-order').click(); await id('asset-trading-columns').waitFor();
      await theme.background(id('order-screen').first(), appearance, 'screen');
      await theme.background(id('asset-trading-columns'), appearance, 'surface');
      await strongButton(id('asset-detail-buy-button'), expectedAction[0]);
      await strongButton(id('order-execute-submit'), expectedAction[0]);
      assert.equal(await color(id('asset-order-book-bids-1').locator('div').first()), up);
      assert.equal(await color(id('asset-order-book-asks-1').locator('div').first()), down);
      assert.equal(await color(id('asset-order-book-bids-1'), 'backgroundColor'), surfaces[appearance][palette][0]);
      assert.equal(await color(id('asset-order-book-asks-1'), 'backgroundColor'), surfaces[appearance][palette][1]);
      await id('asset-detail-sell-button').click();
      await strongButton(id('asset-detail-sell-button'), expectedAction[1]);
      await strongButton(id('order-execute-submit'), expectedAction[1]);
      await theme.canvas(page, appearance);
      records.push({ screen: 'detail/order/chart', appearance, palette, width, fontScale });
      if (width === 390 && fontScale === 1) await page.screenshot({ path: path.join(out, `order-${appearance}-${palette}.png`) });
    }
    for (const appearance of ['light', 'dark']) for (const palette of ['red_blue', 'green_red']) {
      await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
      for (const screen of ['home', 'ranking', 'my', 'market']) {
        await open(screen, `&palette=${palette}`);
        await page.screenshot({ path: path.join(out, `normal-${screen}-${appearance}-${palette}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ records, avatar: 'passed', market: 'passed', persistence: 'passed', crossScreenColors: 'passed', errors }, null, 2));
    for (const name of ['failure.json', 'failure.png']) fs.rmSync(path.join(out, name), { force: true });
    console.log(`PROFILE_FINANCIAL_BROWSER_PASSED ${records.length} layouts + avatar fallback, market sessions, persistence and cross-screen financial colors`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ records, errors, message: error.message }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); throw error;
  } finally { await browser.close(); server.close(); }
}
run().catch((error) => { console.error(error); process.exit(1); });
