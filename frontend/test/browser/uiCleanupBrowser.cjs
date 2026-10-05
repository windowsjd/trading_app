// Real screens and navigators, local transport. Native keyboards are NOT_RUN.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.UI_CLEANUP_BROWSER_OUTPUT ?? '/tmp/trading-ui-cleanup-browser';
const baseline = process.env.UI_CLEANUP_BASELINE;
const secondary = { light: ['rgb(234, 244, 252)', 'rgb(40, 91, 133)'], dark: ['rgb(28, 48, 66)', 'rgb(185, 221, 252)'] };
async function bundle(name, fixture, source = root) {
  const dir = path.join(source, 'test/browser');
  await esbuild.build({ entryPoints: [path.join(dir, `${fixture}Fixture.jsx`)], outfile: path.join(out, `${name}.js`),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'local-boundaries', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /backend\/.*binance-crypto-hot-contract\.json$/ }, () => ({ path: path.join(root, '../backend/src/assets/fixtures/binance-crypto-hot-contract.json') }));
      if (fixture === 'friends') b.onResolve({ filter: /(^@react-navigation\/native$|services\/api\/client$|features\/auth\/useLogout$)/ }, () => ({ path: path.join(dir, 'friendsMocks.js') }));
      else if (fixture === 'trading') {
        b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: path.join(dir, 'tradingMocks.js') }));
        b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useMarketTickers)$/ }, () => ({ path: path.join(dir, 'tradingMocks.js') }));
      } else {
        b.onResolve({ filter: /(services\/api\/client|useMarketTickers)$/ }, () => ({ path: path.join(dir, 'rootTabsMocks.js') }));
        if (fixture === 'rootTabs') b.onResolve({ filter: /navigationHooks$/ }, () => ({ path: path.join(dir, 'rootTabsMocks.js') }));
        if (fixture === 'walletNavigation') b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(dir, 'navigationBootstrap.jsx') }));
      }
    } }], logLevel: 'warning' });
}
async function run() {
  fs.mkdirSync(out, { recursive: true });
  for (const [name, fixture] of [['root', 'rootTabs'], ['navigation', 'walletNavigation'], ['friends', 'friends'], ['trading', 'trading']]) await bundle(name, fixture);
  if (baseline) await bundle('baseline', 'walletNavigation', baseline);
  const server = http.createServer((req, res) => {
    const script = req.url.match(/^\/(\w+)\.js/);
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, `${script[1]}.js`))
      : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/${req.url.split('?')[0].slice(1) || 'root'}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const base = `http://127.0.0.1:${server.address().port}`, errors = [], records = [], spacing = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('selectedTradingAccountId:home-user', `${new URLSearchParams(location.search).get('account') ?? 'season'}-account`);
    localStorage.setItem('trading-app:appearance', 'system');
  });
  const id = name => page.getByTestId(name);
  const walletId = name => id('wallet-screen').getByTestId(name);
  const color = locator => locator.evaluate(el => getComputedStyle(el).color);
  const background = locator => locator.evaluate(el => getComputedStyle(el).backgroundColor);
  const glyphs = async locator => {
    assert.deepEqual(await locator.evaluate(el => {
      const clipped = [], box = el.getBoundingClientRect(), walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) for (let i = 0; i < walk.currentNode.textContent.length; i++) {
        const text = walk.currentNode.textContent; if (!text[i].trim()) continue;
        const range = document.createRange(); range.setStart(walk.currentNode, i); range.setEnd(walk.currentNode, i + 1);
        for (const r of range.getClientRects()) if (r.width && (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1)) clipped.push(text);
      }
      return clipped;
    }), [], 'full glyphs fit their container');
  };
  try {
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2]) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
      const query = `fontScale=${fontScale}&long=1`;
      await page.goto(`${base}/friends?screen=friends&${query}`);
      const tabs = page.getByRole('tab'); await tabs.first().waitFor();
      for (let i = 0; i < 3; i++) {
        await tabs.nth(i).click();
        for (let j = 0; j < 3; j++) {
          assert.equal(await tabs.nth(j).getAttribute('aria-selected'), String(i === j));
          if (i === j) { assert.equal(await background(tabs.nth(j)), secondary[appearance][0]); assert.equal(await color(tabs.nth(j).locator('[dir="auto"]')), secondary[appearance][1]); }
          await glyphs(tabs.nth(j));
        }
      }
      assert.equal(await page.getByText('친구를 찾아보세요.', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '검색', exact: true }).count(), 0);
      const search = page.getByRole('button', { name: '친구 검색', exact: true });
      const input = page.getByPlaceholder('닉네임으로 검색');
      const target = await search.boundingBox(), field = await input.boundingBox();
      assert.ok(target.width >= 44 && target.height >= 44); assert.ok(field.x + field.width <= target.x + 1);
      await input.fill('  없는친구  '); await input.press('Enter'); await page.getByText('검색 결과가 없습니다.', { exact: true }).waitFor();
      await input.fill('친구'); await search.click(); await page.getByRole('button', { name: '친구 요청', exact: true }).waitFor();
      await page.goto(`${base}/friends?screen=settings&${query}`);
      const privacy = id('settings-portfolio-public'), notifications = id('settings-notifications'); await notifications.waitFor();
      assert.equal(await page.getByText('이 기기에만 저장됩니다.', { exact: true }).count(), 0);
      assert.equal(await page.getByText('친구가 내 현재 시즌 포트폴리오를 볼 수 있습니다.', { exact: true }).count(), 0);
      for (const toggle of [privacy, notifications]) {
        assert.equal(await toggle.getByRole('switch').isChecked(), true);
        assert.equal(await toggle.evaluate(el => getComputedStyle(el.firstElementChild).backgroundColor), secondary[appearance][0]);
        assert.equal(await toggle.evaluate(el => getComputedStyle(el.children[1]).backgroundColor), secondary[appearance][1]);
      }
      const p = await privacy.boundingBox(), n = await notifications.boundingBox(); assert.equal(p.width, n.width); assert.equal(p.height, n.height);
      await notifications.getByRole('switch').click(); assert.equal(await notifications.getByRole('switch').isChecked(), false);
      await glyphs(page.getByText('친구에게 포트폴리오 공개', { exact: true }).locator('..'));
      await page.goto(`${base}/root?screen=mode&${query}`); await page.getByText('계정 선택하기', { exact: true }).waitFor();
      await page.getByText('참가중', { exact: true }).waitFor();
      assert.equal(await id('mode-selection-general-use').textContent(), '일반모드');
      assert.equal(await id('mode-selection-season-continue-season-account').textContent(), '시즌모드');
      assert.doesNotMatch(await page.locator('#root').textContent(), /투자 방식을 선택하세요|시간가중|시즌과 무관|일반 투자|시즌 투자/);
      await glyphs(id('mode-selection-screen').locator(':scope > div').first());
      if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `mode-${appearance}-320-scale2.png`), fullPage: true });
      await page.goto(`${base}/root?screen=wallet&account=general&${query}`);
      await id('wallet-composition').waitFor();
      assert.equal(await id('home-trend-toggle').getAttribute('aria-expanded'), 'false');
      await glyphs(page.getByText('총 자산', { exact: true }));
      for (const action of ['wallet-exchange', 'wallet-ledger', 'wallet-orders']) {
        await glyphs(id(`${action}-label`));
        assert.equal(await id(`${action}-label`).evaluate(el => getComputedStyle(el).fontWeight), '600');
      }
      await id('home-trend-toggle').click(); await id('home-trend-chart').waitFor();
      assert.equal(await color(id('home-trend-toggle').locator('[dir="auto"]')), secondary[appearance][1]);
      for (const range of ['7d', '30d', '90d', '180d', '360d']) {
        await glyphs(id(`home-trend-range-${range}`));
        const b = await id(`home-trend-range-${range}`).boundingBox();
        assert.ok(b.x >= 0 && b.x + b.width <= width + 1 && b.height >= 44);
      }
      if (width === 320 && fontScale === 2) {
        await id('home-trend-toggle').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, `wallet-trend-${appearance}-320-scale2.png`) });
      }
      records.push({ appearance, width, fontScale, friends: 'PASS', settings: 'PASS', mode: 'PASS', walletTrend: 'PASS' });
    }
    for (const set of ['none', 'general', 'season', 'past']) {
      await page.goto(`${base}/root?screen=mode&accountSet=${set}&unjoined&long=1&fontScale=2`);
      await page.getByText('계정 선택하기', { exact: true }).waitFor();
      assert.equal(await page.getByText('참가중', { exact: true }).count(), set === 'season' ? 1 : 0);
      if (set === 'none' || set === 'season' || set === 'past') assert.equal(await id('mode-selection-general-start').textContent(), '일반모드');
      if (set === 'none' || set === 'general' || set === 'past') await id('mode-selection-season-join').waitFor();
      if (set === 'past') await id('mode-selection-past-season-season-account').waitFor();
      assert.equal(await page.evaluate(() => window.fixture.transport.requests.some(path => path.includes('open'))), false);
    }
    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      for (const version of baseline ? ['baseline', 'navigation'] : ['navigation']) {
        await page.goto(`${base}/${version}?navigation=1&account=general&holdings=1`); await id('home-total-asset').waitFor();
        await page.getByRole('tab', { name: '지갑', exact: true }).click(); await id('wallet-composition').waitFor();
        const metrics = await page.evaluate(() => {
          const rect = name => document.querySelector(`[data-testid="${name}"]`).getBoundingClientRect();
          const text = [...document.querySelector('[data-testid="wallet-screen"]').querySelectorAll('[dir="auto"]')].find(el => el.textContent === '총 자산');
          return { viewportTop: rect('wallet-screen').top, firstTop: text.getBoundingClientRect().top, gap: text.getBoundingClientRect().top - rect('wallet-screen').top };
        });
        spacing.push({ version, screen: 'wallet', width, ...metrics });
        if (version === 'navigation') {
          assert.equal(metrics.gap, 12);
          const gaps = await page.evaluate(() => {
            const scope = document.querySelector('[data-testid="wallet-screen"]');
            const box = name => scope.querySelector(`[data-testid="${name}"]`).getBoundingClientRect();
            const hero = scope.querySelector('[data-testid="home-total-asset"]').parentElement.getBoundingClientRect();
            const trend = scope.querySelector('[data-testid="home-trend-toggle"]').parentElement.getBoundingClientRect();
            return [trend.top - hero.bottom, box('wallet-quick-actions').top - trend.bottom,
              box('wallet-composition').top - box('wallet-quick-actions').bottom];
          });
          assert.deepEqual(gaps, [12, 12, 12]);
          assert.equal(await color(page.getByRole('tab', { name: '지갑', exact: true }).locator('[dir="auto"]')), 'rgb(50, 111, 229)');
          assert.equal(await page.evaluate(() => window.fixture.transport.equityRequests?.length ?? 0), 0);
          await walletId('home-trend-toggle').click(); await walletId('home-trend-chart').waitFor();
          for (const range of ['7d', '30d', '90d', '180d', '360d']) { await walletId(`home-trend-range-${range}`).click(); await page.waitForFunction(range => window.fixture.transport.equityRequests?.some(r => r.accountId === 'general-account' && r.range === range && r.granularity === 'daily'), range); }
          await page.evaluate(() => window.fixture.navigationRef.navigate('MainTabs', { screen: 'HomeTab' }));
          await id('trading-account-switcher-trigger').click(); await id('trading-account-switcher-option-season-account').click();
          await page.getByRole('tab', { name: '지갑', exact: true }).click(); await id('wallet-composition').waitFor();
          assert.equal(await walletId('home-trend-toggle').getAttribute('aria-expanded'), 'false');
          await walletId('home-trend-toggle').click(); await walletId('home-trend-chart').waitFor();
          await page.waitForFunction(() => window.fixture.transport.equityRequests?.some(r => r.accountId === 'season-account' && r.range === '30d'));
        }
        await page.getByRole('tab', { name: '마켓', exact: true }).click(); await id('market-tab-domestic').waitFor();
        const market = await page.evaluate(() => {
          const viewport = document.querySelector('[data-testid="market-screen"]').getBoundingClientRect();
          const tab = document.querySelector('[data-testid="market-tab-domestic"]').getBoundingClientRect();
          const search = [...document.querySelectorAll('[dir="auto"]')].find(el => el.textContent === '종목명 또는 심볼 검색').parentElement.getBoundingClientRect();
          const toolbar = document.querySelector('[data-testid="market-sort-control"]').parentElement.getBoundingClientRect();
          return { viewportTop: viewport.top, gap: tab.top - viewport.top, searchGap: search.top - tab.bottom, toolbarGap: toolbar.top - search.bottom };
        });
        spacing.push({ version, screen: 'market', width, ...market });
        if (version === 'navigation') { assert.equal(market.gap, 12); assert.equal(market.searchGap, 12); assert.equal(market.toolbarGap, 12); }
      }
    }
    if (baseline) for (const screen of ['wallet', 'market']) for (const width of [320, 360, 390, 430]) {
      assert.ok(spacing.find(r => r.version === 'navigation' && r.screen === screen && r.width === width).gap < spacing.find(r => r.version === 'baseline' && r.screen === screen && r.width === width).gap);
    }
    await page.goto(`${base}/root?screen=ranking`); await id('ranking-top3').waitFor(); assert.doesNotMatch(await page.locator('#root').textContent(), /기준일|캡처|일간 랭킹/);
    await page.goto(`${base}/root?screen=record`); await id('record-season-item-record-0').waitFor(); assert.doesNotMatch(await page.locator('#root').textContent(), /누적 요약|참여 시즌 수|최고 순위|평균 수익률/);
    for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/trading?screen=order&asset=SUI&fontScale=${fontScale}`);
      const input = id('order-quantity-input'); await input.fill('123.456');
      await page.setViewportSize({ width, height: 380 }); await input.focus(); await page.waitForTimeout(150);
      const visible = await input.boundingBox(); assert.ok(visible.y >= 0 && visible.y + visible.height <= 381, 'focused amount is visible after web resize');
      await id('order-execute-submit').scrollIntoViewIfNeeded(); const submit = await id('order-execute-submit').boundingBox(); assert.ok(submit.y >= 0 && submit.y + submit.height <= 381);
      assert.equal(await input.inputValue(), '123.456');
      await id('order-type-toggle-limit').click(); await id('order-limit-price-input').fill('0.8592'); await page.waitForTimeout(150);
      const limit = await id('order-limit-price-input').boundingBox(); assert.ok(limit.y >= 0 && limit.y + limit.height <= 381);
      await page.goto(`${base}/navigation?navigation=1&account=general&fontScale=${fontScale}`); await id('home-total-asset').waitFor();
      await page.getByRole('tab', { name: '지갑', exact: true }).click(); await id('wallet-exchange').click();
      const fx = id('wallet-fx-amount-input'); await fx.fill('123.456'); await page.waitForTimeout(150);
      const fxBox = await fx.boundingBox(); assert.ok(fxBox.y >= 0 && fxBox.y + fxBox.height <= 381);
      await id('wallet-fx-execute-submit').scrollIntoViewIfNeeded(); assert.equal(await fx.inputValue(), '123.456');
      await page.setViewportSize({ width: 844, height: width }); await fx.focus(); await page.waitForTimeout(150); assert.equal(await fx.inputValue(), '123.456');
    }
    assert.deepEqual(errors, []);
    for (const name of ['failure.json', 'failure.png']) fs.rmSync(path.join(out, name), { force: true });
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ records, spacing, errors, nativeKeyboard: 'NOT_RUN', webResize: 'PASS' }, null, 2));
    console.log(`UI_CLEANUP_PASSED ${records.length} Light/Dark font/width combinations; navigator headers/spacing baseline; lazy account trend; search/switch/mode; Web Order/FX resize`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ records, spacing, errors, message: error.message }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); throw error;
  } finally { await browser.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
