// RN Web check of the 환전 sheet (2026-11-04) in the full app fixture: KRW on
// top, two text-free arrows, USD below; either amount can be typed without
// losing focus or the caret; the ratio bar sizes the paying wallet; an amount
// typed to receive is executed as the computed amount to pay. Same external
// esbuild/Playwright runtime as beginnerBrowser.cjs (see README).
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.FX_SHEET_BROWSER_OUTPUT ?? '/tmp/trading-fx-sheet-browser';

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'mainTabHeadersFixture.jsx')], outfile: path.join(out, 'app.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'fx-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'mainTabHeadersNativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook)$/ }, () => ({ path: path.join(__dirname, 'beginnerMocks.js') }));
      b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/app.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'app.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/app.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  const results = [], errors = [];
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const layouts = process.env.FX_SHEET_QUICK === '1' ? [[320, 2, 'light']]
      : [[320, 1, 'light'], [320, 2, 'dark'], [360, 1.3, 'dark'], [390, 1, 'light'], [390, 2, 'light']];
    for (const [width, fontScale, theme] of layouts) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
      await page.addInitScript(mode => {
        localStorage.setItem('selectedTradingAccountId:home-user', 'general-account');
        localStorage.setItem('trading-app:appearance', mode);
      }, theme);
      const id = value => page.getByTestId(value).filter({ visible: true }).first();
      const context = `${width}/${fontScale}/${theme}`;
      await page.goto(`${base}/?account=general&holdings=1&practice=1&fxState=available&fontScale=${fontScale}&theme=${theme}`);
      await id('home-account-title').waitFor();
      await page.locator('a[role="tab"]').filter({ has: page.getByText('지갑', { exact: true }) }).click();
      await id('wallet-exchange').click();
      await id('fx-wallet-krw').waitFor();
      await page.waitForTimeout(450);
      // Order, words and fit.
      const layout = await page.evaluate(() => {
        const top = testId => [...document.querySelectorAll(`[data-testid="${testId}"]`)].find(node => node.checkVisibility())?.getBoundingClientRect();
        const ids = ['fx-wallet-krw', 'wallet-fx-direction-row', 'fx-wallet-usd', 'wallet-fx-ratio', 'fx-indicative-preview', 'wallet-fx-execute-submit'];
        const arrows = ['wallet-fx-direction-krw-usd', 'wallet-fx-direction-usd-krw'].map(testId => {
          const node = [...document.querySelectorAll(`[data-testid="${testId}"]`)].find(item => item.checkVisibility());
          const box = node.getBoundingClientRect();
          return { text: node.textContent, width: box.width, height: box.height, background: getComputedStyle(node).backgroundColor,
            border: getComputedStyle(node).borderTopColor, checked: node.getAttribute('aria-checked'), label: node.getAttribute('aria-label') };
        });
        // Text that leaves the screen sideways or is clipped by its own box.
        const overflow = [];
        const scope = [...document.querySelectorAll('[data-testid="wallet-fx-screen"]')].find(node => node.checkVisibility());
        for (const element of scope.querySelectorAll('*')) {
          if (!element.checkVisibility() || element.closest('[aria-hidden="true"]')) continue;
          for (const node of element.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            const glyph = range.getBoundingClientRect();
            if (glyph.left < -1 || glyph.right > innerWidth + 1) overflow.push(`offscreen:${node.textContent.slice(0, 24)}`);
          }
          const style = getComputedStyle(element);
          if (style.overflowX === 'hidden' && element.scrollWidth > element.clientWidth + 2 && element.tagName !== 'INPUT') overflow.push(`clipped:${element.textContent.slice(0, 24)}`);
        }
        return { tops: ids.map(testId => top(testId)?.top ?? null), arrows, overflow };
      });
      assert.ok(layout.tops.every((top, index) => top !== null && (index === 0 || top > layout.tops[index - 1])), `${context}: order ${layout.tops}`);
      assert.deepEqual(layout.arrows.map(arrow => [arrow.text, arrow.checked, arrow.label]),
        [['', 'true', 'KRW에서 USD로 환전'], ['', 'false', 'USD에서 KRW로 환전']], `${context}: arrows`);
      assert.ok(layout.arrows.every(arrow => arrow.width >= 44 && arrow.height >= 44), `${context}: 44 dp arrows`);
      assert.notEqual(layout.arrows[0].background, layout.arrows[1].background, `${context}: selected fill`);
      assert.notEqual(layout.arrows[0].border, layout.arrows[1].border, `${context}: selected outline`);
      assert.deepEqual(layout.overflow, [], `${context}: nothing clipped`);
      await page.screenshot({ path: path.join(out, `${context.replaceAll('/', '-')}-empty.png`), fullPage: true });

      // Typing the amount to receive: focus and caret stay, the amount to pay follows.
      const usd = id('wallet-fx-usd-amount-input'), krw = id('wallet-fx-krw-amount-input');
      await usd.click();
      await page.keyboard.type('12.5', { delay: 40 });
      const typing = await page.evaluate(() => {
        const active = document.activeElement;
        return { focused: active?.getAttribute('data-testid'), caret: active?.selectionStart, value: active?.value };
      });
      assert.deepEqual(typing, { focused: 'wallet-fx-usd-amount-input', caret: 4, value: '12.5' }, `${context}: typing`);
      const paid = await krw.inputValue();
      assert.ok(Number(paid) > 0 && /^\d+(\.\d{1,8})?$/u.test(paid), `${context}: amount to pay ${paid}`);
      assert.match(await id('fx-indicative-preview').textContent(), /받을 금액에 맞춰 보낼 금액을 계산했습니다/u);
      await page.screenshot({ path: path.join(out, `${context.replaceAll('/', '-')}-receive.png`), fullPage: true });

      // Ratio picks size the paying wallet (9,900,000 KRW spendable in the fixture).
      assert.match(await id('fx-wallet-krw-spendable').textContent(), /^사용 가능 9,900,000원$/u);
      assert.match(await id('fx-wallet-usd-spendable').textContent(), /^사용 가능 \$30\.39$/u, 'USD 50.39 less 20 reserved');
      await id('wallet-fx-ratio-50').click();
      assert.equal(await krw.inputValue(), '4950000', `${context}: 50%`);
      assert.ok(Number(await usd.inputValue()) > 0, `${context}: receive follows`);
      // The other direction: the wallets stay, the typed field becomes the amount to receive.
      await id('wallet-fx-direction-usd-krw').click();
      assert.equal(await id('wallet-fx-direction-usd-krw').getAttribute('aria-checked'), 'true');
      assert.equal(await krw.inputValue(), '4950000', `${context}: kept as typed`);
      assert.ok(Number(await usd.inputValue()) > 3000, `${context}: USD to pay recomputed`);
      // More than the USD wallet can pay: the existing insufficient notice, no command.
      assert.equal(await page.getByText('잔액이 부족합니다.', { exact: true }).filter({ visible: true }).count(), 1, `${context}: insufficient`);
      assert.equal(await id('wallet-fx-execute-submit').getAttribute('aria-disabled'), 'true');
      assert.equal(await id('wallet-fx-krw-amount-input').getAttribute('aria-label'), 'KRW 받을 금액 (예상)');
      await page.screenshot({ path: path.join(out, `${context.replaceAll('/', '-')}-switched.png`), fullPage: true });
      results.push({ context, order: 'KRW/arrows/USD/ratio/estimate/CTA', paid });
      await page.close();
    }

    // Execution of an amount typed to receive: the quote carries the computed amount to pay.
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('selectedTradingAccountId:home-user', 'general-account'));
    const id = value => page.getByTestId(value).filter({ visible: true }).first();
    await page.goto(`${base}/?account=general&holdings=1&practice=1&fxState=available`);
    await id('home-account-title').waitFor();
    await page.locator('a[role="tab"]').filter({ has: page.getByText('지갑', { exact: true }) }).click();
    await id('wallet-exchange').click();
    await id('wallet-fx-usd-amount-input').fill('20');
    const paid = await id('wallet-fx-krw-amount-input').inputValue();
    await page.waitForFunction(() => document.querySelector('[data-testid="wallet-fx-execute-submit"]')?.getAttribute('aria-disabled') !== 'true');
    await id('wallet-fx-execute-submit').click();
    await page.waitForFunction(() => window.beginnerFixture.posts.some(path => path.endsWith('/fx/execute')));
    const quote = await page.evaluate(() => window.beginnerFixture.fxQuote);
    assert.deepEqual([quote.fromCurrency, quote.toCurrency, quote.sourceAmount], ['KRW', 'USD', paid]);
    assert.ok(Number(quote.netTargetAmount) >= 20, `the server-side estimate receives the target: ${quote.netTargetAmount}`);
    await page.screenshot({ path: path.join(out, 'executed-receipt.png'), fullPage: true });
    results.push({ executed: { paid, received: quote.netTargetAmount } });
    await page.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: results.length, results }, null, 1));
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
