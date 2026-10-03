// Existing RN Web/Playwright harness: production Wallet/Home/providers, and
// actual navigators for tab and nested Record reachability. Transport is local.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.WALLET_BROWSER_OUTPUT ?? '/tmp/trading-wallet-browser';
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
    plugins: [{ name: 'wallet-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'rootTabsMocks.js') }));
      if (fixture === 'rootTabs') b.onResolve({ filter: /navigationHooks$/ }, () => ({ path: path.join(__dirname, 'rootTabsMocks.js') }));
      if (fixture === 'walletNavigation') b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.match(/^\/(rootTabs|walletNavigation)\.js/);
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, `${script[1]}.js`))
      : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/${req.url.startsWith('/navigation') ? 'walletNavigation' : 'rootTabs'}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(), errors = [], records = [];
  const base = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const p = new URLSearchParams(location.search);
    localStorage.setItem('selectedTradingAccountId:home-user', `${p.get('account') ?? 'season'}-account`);
    localStorage.setItem('trading-app:appearance', 'system');
    localStorage.setItem('trading-app:financial-colors', p.get('palette') ?? 'red_blue');
  });
  const id = (value) => page.getByTestId(value);
  const open = async (screen, query = '') => {
    await page.goto(`${base}/?screen=${screen}&holdings=1&positionFixtures=hierarchy${query}`);
    await id('home-total-asset').waitFor();
    await id(`${screen === 'wallet' ? 'wallet-position' : 'home-position-item'}-${new URLSearchParams(query).get('account') ?? 'season'}-account-asset-0`).waitFor();
    if (screen === 'home') {
      assert.equal(await page.locator('[data-testid^="home-position-item-"][role="button"]').count(), 1);
      await id('home-holdings-toggle').click();
      await id(`home-position-item-${new URLSearchParams(query).get('account') ?? 'season'}-account-asset-6`).waitFor();
    }
  };
  try {
    if (!process.argv.includes('--navigation-only')) {
      for (const appearance of ['light', 'dark']) for (const preference of ['red_blue', 'green_red'])
        for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2])
          for (const account of ['general', 'season']) for (const long of [0, 1]) for (const screen of ['home', 'wallet']) {
            await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
            await open(screen, `&account=${account}&palette=${preference}&fontScale=${fontScale}&long=${long}`);
            await theme.canvas(page, appearance);
            const prefix = `${screen === 'wallet' ? 'wallet-position' : 'home-position-item'}-${account}-account-asset-`;
            assert.equal(await page.locator(`[data-testid^="${prefix}"][role="button"]`).count(), 7);
            const positive = id(`${prefix}1-return`), negative = id(`${prefix}2-return`), neutral = id(`${prefix}3-return`);
            const color = (locator) => locator.evaluate((el) => getComputedStyle(el).color);
            assert.equal(await color(positive), palette[appearance][preference][0]);
            assert.equal(await color(negative), palette[appearance][preference][1]);
            assert.equal(await neutral.textContent(), '0%');
            assert.equal(await positive.textContent(), '+123.45%'); assert.equal(await negative.textContent(), '-99.12%');
            assert.equal(await id(`${prefix}0-return`).textContent(), '+4.82%');
            for (let index = 0; index < 7; index++) {
              assert.equal(await id(`${prefix}${index}-quantity`).count(), 0);
              assert.doesNotMatch(await id(`${prefix}${index}`).textContent(), /10주|0\.123456주|0\.000805 BTC/);
            }
            if (!long) {
              for (const [index, [name, amount]] of [
                ['삼성전자', '1,120,000원'], ['Berkshire Hathaway Class B', '$123,456.78'], ['Bitcoin', '$123,456.78'],
              ].entries()) {
                assert.equal(await id(`${prefix}${index}-name`).textContent(), name);
                assert.equal(await id(`${prefix}${index}-value`).textContent(), amount);
              }
            }
            const amountColor = await color(id(`${prefix}0-value`));
            assert.ok(!palette[appearance][preference].includes(amountColor));
            assert.ok(!palette[appearance][preference].includes(await color(neutral)));
            assert.match(await id(`${prefix}4`).textContent(), /이전 시세/);
            assert.equal(await id(`${prefix}4-quantity`).count(), 0);
            if (screen === 'wallet') {
              assert.equal(await id('trading-account-switcher-trigger').count(), 0);
              await theme.background(id('wallet-composition'), appearance, 'surface');
              assert.equal(await id(`${prefix}5-value`).textContent(), '-');
              assert.equal(await id(`${prefix}5-return`).textContent(), '-');
              assert.equal(await id(`${prefix}5-quantity`).count(), 0);
            }
            const layout = await page.evaluate(({ prefix, screen }) => {
              const rows = [...document.querySelectorAll(`[data-testid^="${prefix}"][role="button"]`)];
              const boundaries = [...rows, ...['home-summary-card', ...(screen === 'wallet' ? ['wallet-cash-KRW', 'wallet-cash-USD'] : [])].map((name) => document.querySelector(`[data-testid="${name}"]`))];
              const clipped = [];
              for (const row of boundaries) {
                const box = row.getBoundingClientRect(), walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                  const node = walker.currentNode; if (!node.textContent.trim()) continue;
                  // Full-text ranges include trailing wrap spaces beyond the line.
                  // Check visible glyphs so whitespace cannot produce a false clip.
                  for (let i = 0; i < node.textContent.length; i++) {
                    if (!node.textContent[i].trim()) continue;
                    const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
                    const name = node.parentElement.closest('[data-testid$="-name"]');
                    for (const r of range.getClientRects()) {
                      // The complete name remains accessible. Amount,
                      // return and notices must all render in full.
                      if (name && r.top >= name.getBoundingClientRect().bottom) continue;
                      if (r.width && (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1 || r.left < -1 || r.right > innerWidth + 1)) clipped.push({ text: node.textContent, glyph: node.textContent[i], textBox: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, boundary: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } });
                    }
                  }
                }
              }
              const rect = (el) => {
                const r = el.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
              };
              const metrics = rows.map((row) => {
                const part = (suffix) => row.querySelector(`[data-testid="${row.dataset.testid}-${suffix}"]`);
                const style = (el) => {
                  const css = getComputedStyle(el);
                  return { fontSize: parseFloat(css.fontSize), fontWeight: css.fontWeight, color: css.color, textAlign: css.textAlign };
                };
                // Measure the visible glyph right edge as well as the element box.
                const glyphRight = (el) => {
                  const range = document.createRange(); range.selectNodeContents(el);
                  return Math.max(...[...range.getClientRects()].filter((r) => r.width).map((r) => r.right));
                };
                return {
                  name: { ...rect(part('name')), ...style(part('name')), label: part('name').getAttribute('aria-label'), text: part('name').textContent }, column: rect(part('values')),
                  ...Object.fromEntries(['value', 'return'].map((suffix) => [suffix, {
                    ...rect(part(suffix)), ...style(part(suffix)), glyphRight: glyphRight(part(suffix)),
                  }])),
                };
              });
              const history = screen === 'wallet' ? ['wallet-ledger', 'wallet-orders'].map((testID) => {
                const el = document.querySelector(`[data-testid="${testID}"]`), css = getComputedStyle(el);
                return { ...rect(el), padding: css.padding, alignItems: css.alignItems, justifyContent: css.justifyContent,
                  textAlign: getComputedStyle(el.querySelector('[dir="auto"]')).textAlign };
              }) : null;
              return { clipped, metrics, history, heights: rows.map((row) => row.getBoundingClientRect().height), documentWidth: document.documentElement.scrollWidth };
            }, { prefix, screen });
            assert.deepEqual(layout.clipped, [], JSON.stringify({ appearance, preference, width, fontScale, account, long, screen, layout }));
            assert.ok(layout.documentWidth <= width, 'no horizontal overflow');
            for (const row of layout.metrics) {
              assert.ok(row.name.left < row.column.left, 'identity stays left of the numeric column');
              assert.ok(row.name.right + 11 <= row.column.left, 'name and numeric column never overlap');
              assert.ok(row.column.right <= width, 'numeric column stays inside the screen');
              assert.equal(row.name.fontSize, 18 * fontScale);
              assert.equal(row.name.fontWeight, '700');
              assert.equal(row.name.label, row.name.text, 'full identity remains accessible');
              for (const value of [row.value, row.return]) {
                assert.ok(Math.abs(value.right - row.column.right) < 1, 'all numeric boxes share a right edge');
                assert.ok(Math.abs(value.glyphRight - row.column.right) < 1, 'visible numeric glyphs share a right edge');
                assert.equal(value.textAlign, 'right');
              }
              assert.ok(row.value.bottom <= row.return.top, 'value/return lines never overlap');
              assert.equal(row.value.fontSize, 18 * fontScale);
              assert.equal(row.return.fontSize, 14 * fontScale);
              assert.ok(row.value.fontSize > row.return.fontSize);
            }
            if (layout.history) {
              const [ledger, orders] = layout.history;
              assert.ok(Math.abs(ledger.width - orders.width) < 1, 'history buttons have equal rendered widths');
              assert.equal(ledger.height, orders.height); assert.ok(ledger.height >= 44);
              assert.equal(ledger.top, orders.top); assert.equal(ledger.padding, orders.padding);
              for (const button of layout.history) {
                assert.equal(button.alignItems, 'center'); assert.equal(button.justifyContent, 'center'); assert.equal(button.textAlign, 'center');
              }
            }
            if (!long && fontScale === 1) assert.ok(Math.max(...layout.heights) <= 132, 'compact default rows including wrapped Berkshire identity');
            records.push({ appearance, preference, width, fontScale, account, long, screen, layout });
            if (width === 390 && fontScale === 1 && account === 'general') {
              await id(`${prefix}0`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
              await page.screenshot({ path: path.join(out, `${screen}-${appearance}-${preference}-${long}.png`) });
              if (screen === 'wallet') {
                await id('wallet-ledger').scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(out, `wallet-history-${appearance}-${preference}-${long}.png`) });
              }
            }
            if (width === 320 && fontScale === 2 && account === 'general' && appearance === 'light' && preference === 'red_blue') {
              await id(`${prefix}0`).evaluate((el) => el.scrollIntoView({ block: 'start' }));
              await page.screenshot({ path: path.join(out, `${screen}-320-large-font-${long}.png`) });
              if (screen === 'wallet') {
                await id('wallet-ledger').scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(out, `wallet-history-320-large-font-${long}.png`) });
              }
            }
          }

      for (const screen of ['home', 'wallet']) {
        await page.emulateMedia({ colorScheme: 'light' });
        await open(screen, '&account=general&palette=red_blue');
        const rate = id(`${screen === 'wallet' ? 'wallet-position' : 'home-position-item'}-general-account-asset-1-return`);
        await page.evaluate(() => window.fixture.appearance.setFinancialPreference('green_red'));
        await page.waitForFunction((testID) => getComputedStyle(document.querySelector(`[data-testid="${testID}"]`)).color === 'rgb(22, 128, 58)', await rate.getAttribute('data-testid'));
        assert.equal(await rate.textContent(), '+123.45%');
      }
      await open('wallet', '&account=general&many=1');
      await id('wallet-position-general-account-asset-206').waitFor();
      assert.equal(await page.locator('[data-testid^="wallet-position-general-account-asset-"][role="button"]').count(), 207);
      await page.evaluate(() => {
        window.fixture.transport.delay = 'general-account:positions';
        void window.fixture.client.resetQueries({ queryKey: ['tradingAccount', 'positions', 'general-account', 'holdings'] });
      });
      await id('wallet-position-general-account-asset-0').waitFor({ state: 'hidden' });
      assert.equal(await id('trading-account-switcher-trigger').count(), 0);
      await page.evaluate(() => window.fixture.setScreen('home'));
      await id('trading-account-switcher-trigger').click(); await id('trading-account-switcher-option-season-account').click();
      await page.evaluate(() => window.fixture.setScreen('wallet'));
      await id('wallet-position-season-account-asset-0').waitFor();
      assert.equal(await id('home-total-asset').textContent(), '9,648,192원');
      await page.evaluate(() => { window.fixture.transport.delay = null; window.fixture.transport.release(); });
      assert.equal(await id('wallet-position-general-account-asset-0').count(), 0);
      await open('wallet', '&state=settled');
      assert.match(await id('home-summary-card').textContent(), /최종 자산/);
      assert.equal(await id('wallet-exchange').getAttribute('aria-disabled'), 'true');

    }
    // Installed React Navigation: real tabs, MyStack → RecordStack and back paths.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const account of ['general', 'season']) {
      await page.goto(`${base}/navigation?navigation=1&holdings=1&account=${account}`);
      await id('home-total-asset').waitFor();
      const tabs = page.getByRole('tab', { name: /^(홈|마켓|가이드|랭킹|지갑|전체)$/ });
      assert.deepEqual(await tabs.allTextContents(), ['홈', '마켓', account === 'general' ? '가이드' : '랭킹', '지갑', '전체']);
      await page.getByText('환전하기', { exact: true }).click();
      await id('wallet-fx-screen').waitFor();
      await page.evaluate(() => window.fixture.navigationRef.goBack());
      await id('wallet-composition').waitFor();
      await id('wallet-exchange').click();
      await id('wallet-fx-screen').waitFor();
      await page.evaluate(() => window.fixture.navigationRef.goBack());
      await page.getByRole('tab', { name: '지갑' }).click();
      await id('wallet-position-' + account + '-account-asset-6').waitFor();
      await id('wallet-position-' + account + '-account-asset-0').click();
      await id('asset-order-actions').waitFor();
      await page.waitForFunction(() => {
        const footer = document.querySelector('[data-testid="asset-order-actions"]').getBoundingClientRect();
        return Math.abs(footer.bottom - innerHeight) <= 1;
      });
      assert.equal(await page.getByRole('tab', { name: '마켓' }).count(), 0, 'detail owns the bottom safe area');
      await page.evaluate(() => window.fixture.navigationRef.goBack());
      await page.getByRole('tab', { name: '지갑' }).click();
      await id('wallet-composition').waitFor();

      await id('wallet-ledger').click(); await id('wallet-transactions-screen').waitFor();
      await page.evaluate(() => window.fixture.navigationRef.goBack());
      await id('wallet-composition').waitFor();
      await id('wallet-orders').click(); await id('record-order-list-screen').waitFor();
      assert.equal(await page.evaluate(() => window.fixture.navigationRef.getRootState().routes.at(-1).name), 'TradeHistory');
      assert.ok(await page.evaluate((account) => window.fixture.transport.requests.includes(`/trading-accounts/${account}-account/orders`), account));
      await page.evaluate(() => window.fixture.navigationRef.goBack());
      await id('wallet-composition').waitFor();
      assert.equal(await page.getByRole('tab', { name: '지갑' }).getAttribute('aria-selected'), 'true');
      await page.getByRole('tab', { name: '전체' }).click();
      await id('overall-Record').waitFor();
      await id('overall-Record').click(); await id('record-season-item-record-0').click();
      await id('record-season-detail-screen').waitFor();
      for (const [button, destination] of [
        ['record-season-detail-profit-analysis-cta', 'record-profit-analysis-screen'],
        ['record-season-detail-orders-cta', 'record-order-list-screen'],
      ]) {
        await id(button).click(); await id(destination).waitFor();
        await page.evaluate(() => window.fixture.navigationRef.goBack());
        await id('record-season-detail-screen').waitFor();
      }
      await id('record-season-detail-profit-analysis-cta').click();
      await id('record-profit-orders-cta').click(); await id('record-order-list-screen').waitFor();
      await page.evaluate(() => window.fixture.navigationRef.goBack());
      await id('record-profit-analysis-screen').waitFor();
      assert.equal(await id('record-profit-orders-cta').count(), 1);
    }
    assert.deepEqual(errors, []);
    const result = {
      records, navigation: 'passed: installed navigators, FX, ledger and Record flows', errors,
      ...(!process.argv.includes('--navigation-only') ? {
        pagination: 'passed: 207 positions', switching: 'passed: delayed outgoing response', palette: 'passed',
      } : {}),
    };
    fs.writeFileSync(path.join(out, process.argv.includes('--navigation-only') ? 'navigation-results.json' : 'results.json'), JSON.stringify(result, null, 2));
    if (!process.argv.includes('--navigation-only')) {
      for (const name of ['failure.json', 'failure.png']) fs.rmSync(path.join(out, name), { force: true });
    }
    console.log(process.argv.includes('--navigation-only') ? 'WALLET_NAVIGATION_PASSED actual tabs, FX, ledger and all Record destinations' : `WALLET_BROWSER_PASSED ${records.length} layouts + full holdings, switching, palettes, actual tabs and all Record destinations`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ records, errors, message: error.message }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); throw error;
  } finally { await browser.close(); server.close(); }
}
run().catch((error) => { console.error(error); process.exit(1); });
