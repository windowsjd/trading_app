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
    if (!process.argv.includes('--navigation-only') && !process.argv.includes('--transfer-only')) {
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
              const boundaries = [...rows, ...['home-summary-card', ...(screen === 'wallet' ? ['wallet-cash-KRW', 'wallet-cash-USD', 'wallet-cash-crypto_spot-USD', 'wallet-cash-crypto_futures-USD', 'wallet-group-securities-title', 'wallet-group-crypto_spot-title', 'wallet-group-crypto_futures-title', 'wallet-holdings-title', 'wallet-transfer-item', 'wallet-quick-actions', 'wallet-exchange-item', 'wallet-ledger-item', 'wallet-orders-item'] : [])].map((name) => document.querySelector(`[data-testid="${name}"]`))];
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
              const quickActions = screen === 'wallet' ? ['wallet-transfer', 'wallet-exchange', 'wallet-ledger', 'wallet-orders'].map((testID) => {
                const el = document.querySelector(`[data-testid="${testID}"]`);
                const surface = document.querySelector(`[data-testid="${testID}-surface"]`), css = getComputedStyle(surface);
                const item = document.querySelector(`[data-testid="${testID}-item"]`);
                const icon = surface.querySelector('svg[stroke]'), gradient = surface.querySelector('linearGradient');
                const label = document.querySelector(`[data-testid="${testID}-label"]`);
                const labelCss = getComputedStyle(label);
                return { ...rect(surface), target: rect(el), padding: css.padding, background: css.backgroundColor, radius: css.borderRadius,
                  alignItems: css.alignItems, justifyContent: css.justifyContent, icon: rect(icon), label: rect(label),
                  item: rect(item), separateLabel: surface.parentElement === el && label.parentElement === el && surface.nextElementSibling === label,
                  accessibleButtons: item.querySelectorAll('[role="button"]').length, iconStroke: icon.getAttribute('stroke'),
                  rootBackground: getComputedStyle(el).backgroundColor, labelBackground: labelCss.backgroundColor,
                  gradientCount: el.querySelectorAll('linearGradient').length, gradientSurface: gradient && rect(gradient.closest('svg')),
                  gradient: gradient && { points: ['x1', 'y1', 'x2', 'y2'].map(key => gradient.getAttribute(key)),
                    stops: [...gradient.querySelectorAll('stop')].map(stop => [stop.getAttribute('offset'), stop.getAttribute('stop-color')]) },
                  buttonText: el.textContent.trim(), labelText: label.textContent, accessibleName: el.getAttribute('aria-label'),
                  textAlign: labelCss.textAlign, fontSize: parseFloat(labelCss.fontSize), lineHeight: parseFloat(labelCss.lineHeight),
                  fontWeight: labelCss.fontWeight, labelColor: labelCss.color };
              }) : null;
              const quickActionOrder = screen === 'wallet' ? (() => {
                const hero = document.querySelector('[data-testid="home-summary-card"]');
                const group = document.querySelector('[data-testid="wallet-quick-actions"]');
                const composition = document.querySelector('[data-testid="wallet-composition"]');
                return { hero: rect(hero), group: rect(group), composition: rect(composition),
                  followsHero: !!(hero.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING),
                  precedesComposition: !!(group.compareDocumentPosition(composition) & Node.DOCUMENT_POSITION_FOLLOWING) };
              })() : null;
              return { clipped, metrics, quickActions, quickActionOrder, heights: rows.map((row) => row.getBoundingClientRect().height), documentWidth: document.documentElement.scrollWidth };
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
            if (layout.quickActions) {
              const [transfer, exchange, ledger, orders] = layout.quickActions;
              const order = layout.quickActionOrder;
              assert.ok(order.followsHero && order.precedesComposition, 'DOM order is Hero → quick actions → composition');
              assert.ok(order.hero.bottom <= order.group.top && order.group.bottom <= order.composition.top, 'the whole quick action group renders between Hero and composition');
              assert.ok(order.group.left >= 0 && order.group.right <= width, 'the group stays inside the viewport');
              assert.ok(Math.abs(order.group.left + order.group.right - width) < 1, 'the group is centered');
              for (const button of [transfer, ledger, orders]) {
                assert.ok(Math.abs(exchange.width - button.width) < 1, 'quick actions have equal rendered widths');
                for (const property of ['height', 'top', 'padding', 'radius']) assert.equal(button[property], exchange[property]);
                assert.equal(button.icon.top, exchange.icon.top, 'icons align across the row even when labels wrap');
                assert.ok(Math.abs(button.item.width - exchange.item.width) < 1, 'action items reserve equal label widths');
                for (const property of ['fontSize', 'lineHeight', 'fontWeight', 'labelColor']) assert.equal(button[property], exchange[property], 'labels share one typography');
              }
              assert.ok(Math.abs((ledger.left - exchange.right) - (orders.left - ledger.right)) < 1, 'visible button gaps are equal');
              assert.ok(Math.abs((ledger.item.left - exchange.item.right) - (orders.item.left - ledger.item.right)) < 1, 'action item gaps are equal');
              for (const [index, button] of layout.quickActions.entries()) {
                assert.equal(button.width, 52); assert.equal(button.height, 52);
                assert.equal(button.background, 'rgb(50, 111, 229)');
                assert.equal(button.iconStroke, '#FFFFFF');
                assert.equal(button.rootBackground, 'rgba(0, 0, 0, 0)');
                assert.equal(button.labelBackground, 'rgba(0, 0, 0, 0)');
                assert.equal(button.labelColor, theme.palettes[appearance].secondary);
                assert.equal(button.gradientCount, 1, 'one gradient confined to the compact surface');
                assert.deepEqual(button.gradient.points, ['0%', '50%', '100%', '50%']);
                assert.deepEqual(button.gradient.stops, [['0%', '#326FE5'], ['100%', '#4C32E5']]);
                for (const key of ['left', 'top', 'width', 'height']) assert.equal(button.gradientSurface[key], button[key]);
                assert.equal(button.separateLabel, true, 'surface and label are siblings inside one button');
                assert.equal(button.accessibleButtons, 1, 'one accessible action without nested buttons');
                assert.equal(button.buttonText, button.labelText);
                assert.ok(button.target.top <= button.top && button.target.bottom >= button.label.bottom, 'hit target includes surface, gap and label');
                assert.equal(button.labelText, ['이체하기', '환전하기', '원장 보기', '주문 내역'][index]);
                assert.equal(button.accessibleName, button.labelText, 'button remains named for assistive technology');
                assert.equal(button.alignItems, 'center'); assert.equal(button.justifyContent, 'center'); assert.equal(button.textAlign, 'center');
                assert.equal(button.fontSize, 13 * fontScale); assert.equal(button.lineHeight, 20 * fontScale);
                assert.equal(button.icon.width, 24); assert.equal(button.icon.height, 24);
                assert.ok(button.label.top >= button.bottom + 7.9, 'label sits below the entire button with a consistent gap');
                assert.ok(button.label.bottom <= order.group.bottom, 'wrapped labels expand the group without overlapping composition');
                assert.ok(Math.abs(button.label.top - exchange.label.top) < 1, 'all labels start on the same row');
                assert.ok(Math.abs((button.icon.left + button.icon.right) / 2 - (button.left + button.right) / 2) < 1, 'icons are centered');
                assert.ok(Math.abs((button.icon.top + button.icon.bottom) / 2 - (button.top + button.bottom) / 2) < 1, 'icons are vertically centered');
                assert.ok(Math.abs((button.label.left + button.label.right) / 2 - (button.left + button.right) / 2) < 1, 'label is centered below its button');
              }
            }
            if (screen === 'wallet' && account === 'general' && !long && fontScale === 1 && preference === 'red_blue') {
              await page.emulateMedia({ reducedMotion: 'reduce' });
              for (const action of ['wallet-transfer', 'wallet-exchange', 'wallet-ledger', 'wallet-orders']) {
                await id(action).scrollIntoViewIfNeeded();
                const label = await id(`${action}-label`).boundingBox();
                await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
                await page.mouse.down();
                await page.waitForFunction(action => Number(getComputedStyle(document.querySelector(`[data-testid="${action}"]`).firstElementChild).opacity) > 0, action);
                const feedback = await id(action).evaluate(el => {
                  const wash = el.firstElementChild, surface = el.querySelector('[data-testid$="-surface"]'), caption = el.querySelector('[data-testid$="-label"]');
                  const box = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
                  return { wash: box(wash), surface: box(surface), pointerEvents: getComputedStyle(wash).pointerEvents,
                    rootBackground: getComputedStyle(el).backgroundColor, labelBackground: getComputedStyle(caption).backgroundColor,
                    labelOpacity: getComputedStyle(caption).opacity, animations: el.getAnimations({ subtree: true }).length };
                });
                assert.deepEqual(feedback.wash, feedback.surface, 'pressing the label paints only the compact icon surface');
                assert.equal(feedback.rootBackground, 'rgba(0, 0, 0, 0)');
                assert.equal(feedback.labelBackground, 'rgba(0, 0, 0, 0)');
                assert.equal(feedback.labelOpacity, '1');
                assert.equal(feedback.pointerEvents, 'none');
                assert.equal(feedback.animations, 0, 'Reduced Motion keeps immediate static feedback');
                if (width === 390) await page.screenshot({ path: path.join(out, `quick-action-${appearance}-${action}-pressed.png`) });
                await page.mouse.move(0, 0); await page.mouse.up();
                assert.ok(await id('wallet-composition').count());
              }
              await page.emulateMedia({ reducedMotion: 'no-preference' });
            }
            if (!long && fontScale === 1) assert.ok(Math.max(...layout.heights) <= 132, 'compact default rows including wrapped Berkshire identity');
            records.push({ appearance, preference, width, fontScale, account, long, screen, layout });
            if (screen === 'wallet' && preference === 'red_blue' && account === 'general' && !long && [1, 2].includes(fontScale)) {
              await id('home-summary-card').evaluate((el) => el.scrollIntoView({ block: 'start' }));
              await page.screenshot({ path: path.join(out, `wallet-quick-actions-${appearance}-${width}-font-${fontScale}.png`) });
            }
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
      for (const action of ['wallet-ledger', 'wallet-orders']) {
        assert.notEqual(await id(action).getAttribute('aria-disabled'), 'true', 'read-only history stays enabled when exchange is disabled');
      }

    }
    // USD-only production transfer screen, including browser resize/focus evidence.
    if (!process.argv.includes('--navigation-only')) {
      for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430])
        for (const fontScale of [1, 1.5, 2]) for (const account of ['general', 'season'])
          for (const long of [0, 1]) for (const height of [844, 400]) {
            const context = { appearance, width, fontScale, account, long, height };
            await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: appearance });
            await page.goto(`${base}/?screen=transfer&holdings=1&account=${account}&fontScale=${fontScale}&long=${long}`);
            await id('wallet-transfer-available').waitFor(); await theme.canvas(page, appearance);
            assert.equal(await id('trading-account-switcher-trigger').count(), 0);
            assert.equal(await id('wallet-transfer-source-options').count(), 0);
            assert.equal(await id('wallet-transfer-destination-options').count(), 0);
            assert.doesNotMatch(await id('wallet-transfer-screen').textContent(), /KRW|견적|환율|환전|이체 내용 확인|자금 보관/);
            const clipping = async stage => {
              const result = await page.evaluate(() => {
                const failures = [];
                for (const el of document.querySelectorAll('[data-testid="wallet-transfer-screen"] [dir="auto"]')) {
                  const box = el.getBoundingClientRect(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                  while (walker.nextNode()) for (let i = 0; i < walker.currentNode.textContent.length; i++) {
                    if (!walker.currentNode.textContent[i].trim()) continue;
                    const range = document.createRange(); range.setStart(walker.currentNode, i); range.setEnd(walker.currentNode, i + 1);
                    for (const r of range.getClientRects()) if (r.width && (r.left < -1 || r.right > innerWidth + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1)) failures.push(el.textContent);
                  }
                }
                return { failures, width: document.documentElement.scrollWidth };
              });
              assert.deepEqual(result.failures, [], JSON.stringify({ ...context, stage, result })); assert.ok(result.width <= width);
            };
            await clipping('collapsed');
            if ([320, 390].includes(width) && [1, 2].includes(fontScale) && account === 'general' && !long && height === 844) await page.screenshot({ path: path.join(out, `transfer-form-${appearance}-${width}-font${fontScale}.png`) });
            await id('wallet-transfer-amount').focus();
            await id('wallet-transfer-source-selector').click();
            assert.equal(await id('wallet-transfer-source-selector').getAttribute('aria-expanded'), 'true');
            assert.equal(await id('wallet-transfer-source-crypto_spot').count(), 0);
            assert.equal(await id('wallet-transfer-source-selector').locator('svg').count(), 1);
            assert.equal(await id('wallet-transfer-amount').evaluate(el => document.activeElement === el), false);
            await clipping('dropdown');
            if (width === 320 && fontScale === 2 && account === 'general' && !long && height === 844) await page.screenshot({ path: path.join(out, `transfer-dropdown-${appearance}-320-font2.png`) });
            await id('wallet-transfer-source-crypto_futures').click();
            assert.equal(await id('wallet-transfer-source-options').count(), 0);
            await page.waitForFunction(() => document.querySelector('[data-testid="wallet-transfer-available"]').textContent.includes('USD'));
            assert.match(await id('wallet-transfer-available').textContent(), long ? /1234567890100/ : /25/);
            await id('wallet-transfer-amount').fill(long ? '1234567890123456.12345678' : '25.00000001');
            assert.equal(await id('wallet-transfer-submit').getAttribute('aria-disabled'), 'true');
            await clipping('amount-too-large');
            await id('wallet-transfer-destination-selector').click();
            assert.equal(await id('wallet-transfer-destination-crypto_futures').count(), 0);
            await id('wallet-transfer-amount').focus();
            assert.equal(await id('wallet-transfer-destination-options').count(), 0);
            await id('wallet-transfer-amount').fill('10');
            await id('wallet-transfer-submit').click(); await id('wallet-transfer-success').waitFor();
            await clipping('success');
            const requests = await page.evaluate(() => window.fixture.transport.postRequests);
            assert.equal(requests.length, 1); assert.equal(requests[0].path, `/trading-accounts/${account}-account/wallet-transfers`);
            assert.equal(requests[0].body.sourceWalletId, `${account}-account:futures`); assert.equal(requests[0].body.amount, '10.00000000');
            if (width === 320 && fontScale === 2 && account === 'general' && !long && height === 844) await page.screenshot({ path: path.join(out, `transfer-${appearance}-320-font2.png`), fullPage: true });
            records.push({ screen: 'transfer', ...context, stages: 'collapsed/dropdown/long amount/success', clipping: 'passed' });
          }
      // Failure surface plus incoming Futures transfer must remain usable.
      for (const appearance of ['light', 'dark']) {
        await page.setViewportSize({ width: 320, height: 400 }); await page.emulateMedia({ colorScheme: appearance });
        await page.goto(`${base}/?screen=transfer&holdings=1&account=general&fontScale=2&riskUnavailable=1`);
        await id('wallet-transfer-source-selector').waitFor(); await id('wallet-transfer-source-selector').click(); await id('wallet-transfer-source-crypto_futures').click();
        await id('wallet-transfer-amount').fill('1'); assert.equal(await id('wallet-transfer-submit').getAttribute('aria-disabled'), 'true');
        assert.doesNotMatch(await id('wallet-transfer-available').textContent(), /USD/);
        await id('wallet-transfer-source-selector').click(); await id('wallet-transfer-source-securities').click();
        await id('wallet-transfer-destination-selector').click(); await id('wallet-transfer-destination-crypto_futures').click();
        await page.evaluate(() => { window.fixture.transport.transferError = 'INSUFFICIENT_FUTURES_FREE_COLLATERAL'; });
        await id('wallet-transfer-submit').click(); await id('wallet-transfer-error').waitFor();
        assert.match(await id('wallet-transfer-error').textContent(), /이체 가능 금액이 부족/);
        assert.doesNotMatch(await id('wallet-transfer-error').textContent(), /internal fixture/);
        await page.evaluate(() => { window.fixture.transport.transferError = null; });
        await id('wallet-transfer-submit').click(); await id('wallet-transfer-success').waitFor();
        assert.equal(await page.evaluate(() => window.fixture.transport.postRequests.length), 2);
        records.push({ screen: 'transfer-unavailable-error-incoming', appearance, width: 320, height: 400, fontScale: 2 });
      }
      if (process.argv.includes('--transfer-only')) {
        assert.deepEqual(errors, []);
        fs.writeFileSync(path.join(out, 'transfer-results.json'), JSON.stringify({ records, errors, nativeKeyboard: 'NOT_RUN: browser resize is not a native keyboard' }, null, 2));
        console.log(`WALLET_TRANSFER_BROWSER_PASSED ${records.length} cases: widths/font scales/themes/general/season/short viewport + unavailable/error/incoming`);
        for (const name of ['failure.json', 'failure.png']) fs.rmSync(path.join(out, name), { force: true });
        return;
      }
    }
    // Installed React Navigation: real tabs, MyStack → RecordStack and back paths.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const account of ['general', 'season']) {
      await page.goto(`${base}/navigation?navigation=1&holdings=1&account=${account}`);
      await id('home-total-asset').waitFor();
      const tabs = page.getByRole('tab', { name: /^(홈|마켓|가이드|랭킹|지갑|MY)$/ });
      assert.deepEqual(await tabs.allTextContents(), ['홈', '마켓', account === 'general' ? '가이드' : '랭킹', '지갑', 'MY']);
      assert.equal(await page.getByText('환전하기', { exact: true }).count(), 0);
      await page.getByRole('tab', { name: '지갑' }).click();
      await id('wallet-composition').waitFor();
      assert.equal(await id('wallet-exchange-label').textContent(), '환전하기');
      assert.notEqual(await id('wallet-exchange').getAttribute('aria-disabled'), 'true');
      for (const [action, destination, marker] of [
        ['wallet-transfer', 'WalletTransfer', 'wallet-transfer-screen'],
        ['wallet-exchange', 'WalletFx', 'wallet-fx-screen'],
        ['wallet-ledger', 'WalletTransactions', 'wallet-transactions-screen'],
        ['wallet-orders', 'TradeHistory', 'record-order-list-screen'],
      ]) for (const area of ['surface', 'label', 'gap']) {
        await id(action).scrollIntoViewIfNeeded();
        const surface = await id(`${action}-surface`).boundingBox(), label = await id(`${action}-label`).boundingBox();
        const point = area === 'surface' ? { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2 }
          : area === 'label' ? { x: label.x + label.width / 2, y: label.y + label.height / 2 }
            : { x: surface.x + surface.width / 2, y: (surface.y + surface.height + label.y) / 2 };
        assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).closest('[role="button"]').dataset.testid, point), action, 'hit area never overlaps a neighboring action');
        await page.mouse.click(point.x, point.y);
        await id(marker).waitFor();
        const route = await page.evaluate(() => window.fixture.navigationRef.getCurrentRoute());
        assert.equal(route.name, destination, `${account}: ${action} ${area}`);
        if (action === 'wallet-orders') assert.equal(route.params.accountId, `${account}-account`);
        await page.evaluate(() => window.fixture.navigationRef.goBack());
        await id('wallet-composition').waitFor();
        assert.equal(await page.getByRole('tab', { name: '지갑' }).getAttribute('aria-selected'), 'true');
      }
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
      await page.getByRole('tab', { name: 'MY' }).click();
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
    await page.goto(`${base}/navigation?navigation=1&holdings=1&account=general`);
    await id('home-total-asset').waitFor();
    await id('trading-account-switcher-trigger').click();
    await id('trading-account-switcher-option-season-account').click();
    await page.getByRole('tab', { name: '지갑' }).click();
    await id('wallet-composition').waitFor();
    await id('wallet-orders-label').click();
    await id('record-order-list-screen').waitFor();
    assert.equal(await page.evaluate(() => window.fixture.navigationRef.getCurrentRoute().params.accountId), 'season-account', 'history captures the Wallet account after switching');
    await page.goto(`${base}/navigation?navigation=1&holdings=1&account=season&state=settled`);
    await id('home-total-asset').waitFor();
    await page.getByRole('tab', { name: '지갑' }).click();
    await id('wallet-composition').waitFor();
    assert.equal(await id('wallet-exchange').getAttribute('aria-disabled'), 'true');
    assert.equal(await id('wallet-exchange-surface').evaluate(el => getComputedStyle(el).opacity), '0.45');
    assert.equal(await id('wallet-exchange-label').evaluate(el => getComputedStyle(el).opacity), '0.45');
    assert.deepEqual(await id('wallet-exchange-surface').locator('linearGradient stop').evaluateAll(nodes => nodes.map(node => node.getAttribute('stop-color'))), ['#326FE5', '#4C32E5']);
    for (const area of ['surface', 'label', 'gap']) {
      await id('wallet-exchange').scrollIntoViewIfNeeded();
      const surface = await id('wallet-exchange-surface').boundingBox(), label = await id('wallet-exchange-label').boundingBox();
      const y = area === 'surface' ? surface.y + surface.height / 2 : area === 'label' ? label.y + label.height / 2 : (surface.y + surface.height + label.y) / 2;
      await page.mouse.click(surface.x + surface.width / 2, y);
      assert.equal(await page.evaluate(() => window.fixture.navigationRef.getCurrentRoute().name), 'Wallet');
      assert.equal(await id('wallet-fx-screen').count(), 0);
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
