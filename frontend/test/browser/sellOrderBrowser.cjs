// Optional real RN Web check of the SELL order methods (3rd order phase): the
// 주문방식 sheet for KRX/crypto SELL, the SELL condition form, the 손절가/익절가
// 설정 form (2026-10-15: market only, share sliders), LOC SELL with a reduced acceptance and its
// success sheet, the SELL pending lists and a stop-loss fill banner.
// Screenshots at 320/360/390/430px, light/dark and 1x/2x fonts, with a
// clipped-text / sideways-scroll detector and touch-target checks.
// Requires external esbuild and Playwright (see README).
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.SELL_ORDER_BROWSER_OUTPUT ?? '/tmp/trading-sell-order-browser';

/** Text cut by its own box or a clipping ancestor; skips hidden measurers. */
async function clipped(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.getAttribute('aria-hidden') === 'true' || style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none') return false;
      }
      return true;
    };
    const issues = [];
    // The order-book ladder already overflows at 320px / large fonts at HEAD.
    const ladder = document.querySelector('[data-testid="asset-order-book"]');
    for (const el of document.querySelectorAll('div, span')) {
      const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (!own || !visible(el) || ladder?.contains(el)) continue;
      const style = getComputedStyle(el);
      if (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none') issues.push(`ellipsis: ${el.textContent.slice(0, 40)}`);
      if (el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible') issues.push(`width: ${el.textContent.slice(0, 40)}`);
      const rect = el.getBoundingClientRect();
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const parent = getComputedStyle(node);
        if (parent.overflow === 'visible' || node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1) continue;
        const box = node.getBoundingClientRect();
        if (rect.right > box.right + 1 || rect.left < box.left - 1) { issues.push(`cut: ${el.textContent.slice(0, 40)}`); break; }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`page scrolls sideways: ${document.documentElement.scrollWidth}`);
    return issues;
  });
}

/** New SELL controls keep a usable touch target and an accessible name. */
async function controls(page) {
  return page.evaluate(() => {
    const issues = [];
    for (const el of document.querySelectorAll('[data-testid^="sell-"]')) {
      const role = el.getAttribute('role');
      if (!['button', 'radio', 'checkbox', 'tab'].includes(role ?? '')) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.height < 31.5) issues.push(`small target ${el.dataset.testid}: ${Math.round(box.height)}px`);
      if (!(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()) issues.push(`no name ${el.dataset.testid}`);
      if (role === 'checkbox' && el.getAttribute('aria-checked') === null) issues.push(`no checked state ${el.dataset.testid}`);
    }
    return issues;
  });
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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BEGINNER_CHROMIUM || undefined });
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = [];
  try {
    const quick = process.env.SELL_ORDER_QUICK === '1';
    const combos = [];
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const fontScale of [1, 2]) combos.push([width, appearance, fontScale]);
    for (const [width, appearance, fontScale] of quick ? [[360, 'light', 1], [320, 'dark', 2]] : combos) {
      const page = await browser.newPage({ viewport: { width, height: 760 } });
      await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
      await page.emulateMedia({ colorScheme: appearance });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
      const tag = `${width}-${appearance}-${fontScale}x`;
      const shot = async (name) => {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(450);
        const issues = [...await clipped(page), ...await controls(page)];
        report.push({ shot: `${name}-${tag}`, issues });
        await page.screenshot({ path: path.join(out, `${name}-${tag}.png`) });
      };
      const go = async (query) => {
        await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&${query}`);
        await page.getByTestId('order-type-select').waitFor();
        await page.getByTestId('asset-detail-sell-button').click();
        await page.waitForTimeout(250);
      };
      const field = () => page.getByTestId('order-type-select');
      const row = (method) => page.getByTestId(`order-method-${method}`);
      const pick = async (method) => {
        await field().click();
        await row(method).waitFor();
        await row(method).scrollIntoViewIfNeeded();
        await row(method).click();
        await page.waitForTimeout(250);
      };
      const reachable = async (methods) => {
        for (const method of methods) {
          await row(method).scrollIntoViewIfNeeded();
          await page.waitForTimeout(50);
          const box = await row(method).boundingBox();
          const list = await page.getByTestId('order-method-list').boundingBox();
          assert.ok(box.y >= list.y - 1 && box.y + box.height <= list.y + list.height + 1, `${method} inside the sheet (${tag})`);
          assert.ok(box.y + box.height <= page.viewportSize().height + 1, `${method} inside the viewport (${tag})`);
        }
      };

      // 1. KRX SELL sheet: 시장가 + three server-gated methods, never a new 지정가.
      await go('krx=1&asset=SAMSUNG&longName=1&sell=enabled&locSell=enabled&holding=10&reserved=6');
      await field().click();
      for (const method of ['market', 'conditional', 'loc', 'protection']) await row(method).waitFor();
      assert.equal(await row('limit').count(), 0, `no new sell limit (${tag})`);
      for (const method of ['conditional', 'loc', 'protection'])
        assert.equal(await page.getByTestId(`order-method-${method}-badge`).count(), 0, `${method} available (${tag})`);
      await shot('krx-sell-sheet');
      await reachable(['market', 'conditional', 'loc', 'protection']);
      await page.getByTestId('order-method-sheet-close').click();

      // 2. SELL condition: watch vs limit price, target above the unreserved part.
      await pick('conditional');
      await page.getByTestId('sell-condition-form').waitFor();
      await page.getByTestId('sell-trigger-at_or_below').click();
      await page.getByTestId('sell-condition-trigger-price').fill('123456789.12345678');
      await page.getByTestId('sell-condition-execution-limit').click();
      await page.getByTestId('sell-condition-limit-price').fill('123456788.12345678');
      await page.getByTestId('sell-condition-all').click();
      assert.equal(await page.getByTestId('sell-condition-quantity').inputValue(), '10', `보유 전량 fills the holding (${tag})`);
      await page.getByTestId('sell-condition-quantity-notice').waitFor();
      await page.getByTestId('sell-condition-form').scrollIntoViewIfNeeded();
      await shot('krx-sell-condition');
      await page.getByTestId('sell-intent-submit').click();
      await page.getByTestId('sell-intent-registered').waitFor();
      await page.getByTestId('sell-intent-registered').scrollIntoViewIfNeeded();
      const registered = await page.getByTestId('sell-intent-registered').innerText();
      assert.ok(registered.includes('감시 중입니다') && !registered.includes('체결됐어요'), `registration is not a sale (${tag})`);
      await shot('krx-sell-condition-registered');

      // 3. 손절가/익절가 설정: 익절 then 손절, each a share of the holding, market only
      //    (crypto, tiny decimals, a large reservation elsewhere).
      await go('asset=SUI&longName=1&sell=enabled&holding=1234567.123456&reserved=1000000');
      await pick('protection');
      await page.getByTestId('sell-protection-form').waitFor();
      assert.equal(await page.getByTestId('sell-take-profit-execution-limit').count() + await page.getByTestId('sell-stop-loss-execution-limit').count(), 0, `no execution choice (${tag})`);
      const sections = await page.locator('[data-testid$="-section"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.testid));
      assert.deepEqual(sections, ['sell-take-profit-section', 'sell-stop-loss-section'], `익절 first (${tag})`);
      await page.getByTestId('sell-take-profit-toggle').click();
      assert.equal(await page.getByTestId('sell-take-profit-toggle').getAttribute('aria-checked'), 'true', `toggle state (${tag})`);
      await page.getByTestId('sell-take-profit-trigger-price').fill('98765.12345678');
      await page.getByTestId('sell-take-profit-ratio-25').click();
      await page.getByTestId('sell-stop-loss-toggle').click();
      await page.getByTestId('sell-stop-loss-trigger-price').fill('0.00000381');
      await page.getByTestId('sell-stop-loss-slider').fill('100');
      const stopQuantity = await page.getByTestId('sell-stop-loss-quantity').innerText();
      assert.ok(stopQuantity.includes('1234567.123456'), `100% is the whole holding (${tag}): ${stopQuantity}`);
      assert.equal(await page.getByTestId('sell-stop-loss-percent').innerText(), '100%', `share shown (${tag})`);
      assert.ok((await page.getByTestId('sell-take-profit-quantity').innerText()).includes('308641.780864'), `25% floors to 6 decimals (${tag})`);
      await page.getByTestId('sell-stop-loss-quantity-notice').waitFor();
      await page.getByTestId('sell-protection-form').scrollIntoViewIfNeeded();
      await shot('crypto-sell-protection');
      await page.getByTestId('sell-intent-submit').scrollIntoViewIfNeeded();
      assert.equal(await page.getByTestId('sell-intent-submit').innerText(), '확인', `확인 label (${tag})`);
      await shot('crypto-sell-protection-policy');
      await page.getByTestId('sell-intent-submit').click();
      await page.getByTestId('sell-intent-registered').waitFor();
      await page.getByTestId('sell-intent-registered').scrollIntoViewIfNeeded();
      await shot('crypto-sell-protection-registered');
      // 3b. A live whole-position OCO on the asset is explained before registration.
      await go('asset=SUI&longName=1&sell=enabled&holding=10&protection=active');
      await pick('protection');
      await page.getByTestId('sell-intent-blocked').waitFor();
      assert.ok((await page.getByTestId('sell-intent-blocked').innerText()).includes('(OCO)'), `OCO conflict explained (${tag})`);
      await page.getByTestId('sell-intent-blocked').scrollIntoViewIfNeeded();
      await shot('crypto-sell-protection-oco');

      // 4. KRX LOC SELL: 10 asked with 6 reserved elsewhere → 4 accepted, both shown.
      await go('krx=1&asset=SAMSUNG&longName=1&locSell=enabled&holding=10&reserved=6');
      await pick('loc');
      await page.getByTestId('loc-order-notice').waitFor();
      await page.getByTestId('order-limit-price-input').fill('70000');
      await page.getByTestId('order-quantity-input').fill('10');
      await page.getByTestId('loc-sell-adjust-notice').waitFor();
      await page.getByTestId('loc-order-notice').scrollIntoViewIfNeeded();
      await shot('krx-loc-sell');
      await page.getByTestId('order-execute-submit').scrollIntoViewIfNeeded();
      await page.getByTestId('order-execute-submit').click();
      await page.getByTestId('loc-quantity-adjusted').waitFor();
      const success = await page.getByTestId('loc-success-message').innerText();
      assert.ok(success.includes('지정가격 이상이면'), `LOC SELL success copy (${tag})`);
      await shot('krx-loc-sell-success');

      // 5. Market SELL with part of the holding reserved: holding vs unreserved shown.
      await go('krx=1&asset=SAMSUNG&longName=1&holding=10&reserved=6');
      await pick('market');
      await page.getByTestId('order-quantity-input').fill('7');
      await page.getByTestId('order-available-helper').scrollIntoViewIfNeeded();
      const helper = await page.getByTestId('order-available-helper').innerText();
      assert.ok(helper.includes('매도 가능 4'), `unreserved part shown (${tag})`);
      await shot('krx-sell-market-reserved');

      // 6. The SELL pending lists (condition tab and TP/SL tab).
      await go('asset=SUI&longName=1&sell=enabled&sellRows=1&conditional=enabled');
      await page.getByTestId('holdings-filter-pending').click();
      await page.getByTestId('pending-kind-conditional').click();
      await page.getByTestId('sell-orders-condition-open').waitFor();
      await page.getByTestId('sell-orders-condition').scrollIntoViewIfNeeded();
      await shot('sell-condition-list');
      await page.getByTestId('sell-orders-condition-ended').scrollIntoViewIfNeeded();
      await shot('sell-condition-history');
      await page.getByTestId('pending-kind-protection').click();
      await page.getByTestId('sell-orders-protection-open').waitFor();
      await page.getByTestId('sell-orders-protection').scrollIntoViewIfNeeded();
      await shot('sell-protection-list');

      // 7. A stop-loss sale announced by the top banner.
      await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&krx=1&asset=SAMSUNG&fillBanner=sell&longName=1`);
      await page.getByTestId('order-fill-banner').waitFor();
      await shot('sell-fill-banner');
      assert.deepEqual(errors, [], `${tag} page errors`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failing = report.filter((entry) => entry.issues.length);
  assert.deepEqual(failing, [], 'clipped text, sideways scroll or unusable controls');
  console.log(`sell order browser: ${report.length} screens checked, screenshots in ${out}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
