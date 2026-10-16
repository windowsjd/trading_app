// Optional real RN Web check of the 손절가/익절가 sheets (holding, order draft,
// pending entry, Futures position), the ended-plan list and the automatic
// 이상/이하 of a conditional BUY: screenshots at 320/360/390/430px, light/dark
// and 1x/1.5x/2x fonts, with a clipped-text / sideways-scroll detector and
// sheet geometry checks (inside the viewport, submit reachable, a focused
// price input kept in view). Requires external esbuild and Playwright (see README).
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.TP_SL_BROWSER_OUTPUT ?? '/tmp/trading-tp-sl-browser';

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
    const quick = process.env.TP_SL_BROWSER_QUICK === '1';
    const combos = [];
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const fontScale of [1, 1.5, 2]) combos.push([width, appearance, fontScale]);
    for (const [width, appearance, fontScale] of quick ? [[360, 'light', 1], [320, 'dark', 2], [390, 'light', 1.5]] : combos) {
      // A short viewport stands in for a phone with its keyboard up.
      const height = fontScale === 2 ? 640 : 760;
      const page = await browser.newPage({ viewport: { width, height } });
      await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
      await page.emulateMedia({ colorScheme: appearance });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
      const tag = `${width}-${appearance}-${fontScale}x`;
      const shot = async (name) => {
        // Let sheet/press motion settle (rows count as visible while still sliding).
        await page.mouse.move(0, 0);
        await page.waitForTimeout(450);
        const issues = await clipped(page);
        report.push({ shot: `${name}-${tag}`, issues });
        await page.screenshot({ path: path.join(out, `${name}-${tag}.png`) });
      };
      const go = async (query, ready = 'order-type-select') => {
        await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&${query}`);
        await page.getByTestId(ready).waitFor();
      };
      const inside = (box, frame, what) => assert.ok(box && frame && box.y >= frame.y - 1 && box.y + box.height <= frame.y + frame.height + 1
        && box.x >= frame.x - 1 && box.x + box.width <= frame.x + frame.width + 1, `${what} (${tag})`);
      const viewport = () => ({ x: 0, y: 0, width, height });
      /** The open sheet sits on screen; its submit and a focused price stay reachable inside its scroll. */
      const sheetGeometry = async (priceInput) => {
        const scroll = await page.getByTestId('tp-sl-scroll').boundingBox();
        inside(scroll, viewport(), 'sheet body inside the viewport');
        await page.getByTestId(priceInput).click();
        await page.waitForTimeout(250);
        inside(await page.getByTestId(priceInput).boundingBox(), await page.getByTestId('tp-sl-scroll').boundingBox(), `focused ${priceInput} kept in view`);
        await page.getByTestId('tp-sl-submit').scrollIntoViewIfNeeded();
        await page.waitForTimeout(100);
        inside(await page.getByTestId('tp-sl-submit').boundingBox(), await page.getByTestId('tp-sl-scroll').boundingBox(), 'submit reachable');
      };
      const fillLegs = async (tp, sl, tpRatio = 25, slRatio = 100) => {
        await page.getByTestId('tp-sl-take-profit-toggle').click();
        await page.getByTestId('tp-sl-take-profit-trigger-price').fill(tp);
        await page.getByTestId(`tp-sl-take-profit-ratio-${tpRatio}`).click();
        await page.getByTestId('tp-sl-stop-loss-toggle').click();
        await page.getByTestId('tp-sl-stop-loss-trigger-price').fill(sl);
        await page.getByTestId(`tp-sl-stop-loss-ratio-${slRatio}`).click();
      };

      // 1. 주문방식 field: the method on the left, a large ▼ on the right, no extra hint.
      await go('asset=SUI&longName=1');
      assert.equal(await page.getByTestId('order-type-select-hint').count(), 0, `no 주문방식 선택하기 hint (${tag})`);
      const fieldBox = await page.getByTestId('order-type-select').boundingBox();
      const triangle = await page.getByTestId('order-type-select-chevron').boundingBox();
      const value = await page.getByTestId('order-type-select-value').boundingBox();
      assert.ok(fieldBox.x + fieldBox.width - (triangle.x + triangle.width) <= 28 && triangle.x > value.x, `▼ at the field's right (${tag})`);
      assert.ok(triangle.width >= 13, `the larger ▼ (${tag})`);

      // 2. Holding card → its sheet: 매도 가능 금액, both kinds, shares, register.
      await go('asset=SUI&sell=enabled&valuation=1&plans=enabled&longName=1');
      await page.getByTestId('holding-SUI-tp-sl').scrollIntoViewIfNeeded();
      await page.getByTestId('holding-SUI-tp-sl').click();
      await page.getByTestId('tp-sl-spot-holding').waitFor();
      assert.match(await page.getByTestId('tp-sl-sellable-amount').innerText(), /^매도 가능 금액 \$3\.43$/, `sellable amount (${tag})`);
      await fillLegs('0.95', '0.8');
      await page.getByTestId('tp-sl-take-profit-section').scrollIntoViewIfNeeded();
      await shot('holding-sheet');
      await sheetGeometry('tp-sl-stop-loss-trigger-price');
      await page.getByTestId('tp-sl-submit').click();
      await page.getByTestId('tp-sl-registered').waitFor();
      await page.getByTestId('tp-sl-registered').scrollIntoViewIfNeeded();
      await shot('holding-registered');

      // 2b. A holding with many registered settings (every state): the list inside the sheet.
      await go('asset=SUI&sell=enabled&valuation=1&plans=enabled&sellRows=1&longName=1');
      await page.getByTestId('holding-SUI-tp-sl').scrollIntoViewIfNeeded();
      await page.getByTestId('holding-SUI-tp-sl').click();
      await page.getByTestId('tp-sl-live').waitFor();
      // The live reads return 익절·손절 × (watching, triggered, order_pending).
      assert.equal(await page.locator('[data-testid^="tp-sl-setting-"][data-testid$="-state"]').count(), 6, `registered settings listed (${tag})`);
      await page.getByTestId('tp-sl-live').scrollIntoViewIfNeeded();
      await shot('holding-sheet-list');
      await page.getByTestId('tp-sl-sheet-close').click();

      // 3. A new limit BUY: plans are drafted in the same sheet and sent with the order.
      await go('asset=SUI&plans=enabled&longName=1');
      await page.getByTestId('order-type-select').click();
      await page.getByTestId('order-method-limit').click();
      await page.getByTestId('order-limit-price-input').fill('0.85');
      await page.getByTestId('order-quantity-input').fill('10');
      await page.getByTestId('order-tp-sl-button').scrollIntoViewIfNeeded();
      await page.getByTestId('order-tp-sl-button').click();
      await page.getByTestId('tp-sl-draft').waitFor();
      await fillLegs('0.95', '0.8', 50, 100);
      await shot('order-draft-sheet');
      await sheetGeometry('tp-sl-take-profit-trigger-price');
      await page.getByTestId('tp-sl-submit').click();
      await page.getByTestId('tp-sl-drafts').waitFor();
      await page.getByTestId('tp-sl-sheet-close').click();
      await page.getByTestId('order-tp-sl-button-summary').scrollIntoViewIfNeeded();
      assert.equal(await page.getByTestId('order-tp-sl-button-summary').innerText(), '익절 1건 · 손절 1건', `draft count (${tag})`);
      await shot('order-with-plans');

      // 4. A pending BUY limit: its sheet (expected fill, the plan on it) and the ended list.
      await go('asset=SUI&plans=enabled&pending=1&planRows=1&longName=1');
      await page.getByTestId('holdings-filter-pending').click();
      await page.getByTestId('pending-order-buy-tp-sl').scrollIntoViewIfNeeded();
      await page.getByTestId('pending-order-buy-tp-sl').click();
      await page.getByTestId('tp-sl-entry').waitFor();
      assert.match(await page.getByTestId('tp-sl-entry-quantity').innerText(), /^체결 예정 수량 /, `expected fill (${tag})`);
      await page.getByTestId('tp-sl-plan-plan-tp').waitFor();
      await page.getByTestId('tp-sl-take-profit-toggle').click();
      await page.getByTestId('tp-sl-take-profit-trigger-price').fill('1234567890123458');
      await page.getByTestId('tp-sl-take-profit-ratio-50').click();
      await shot('pending-entry-sheet');
      await sheetGeometry('tp-sl-take-profit-trigger-price');
      await page.getByTestId('tp-sl-sheet-close').click();
      await page.getByTestId('pending-kind-protection').click();
      await page.getByTestId('entry-tp-sl-history-toggle').click();
      await page.getByTestId('entry-tp-sl-plan-failed').waitFor();
      assert.equal(await page.getByTestId('entry-tp-sl-plan-failed-state').innerText(), '활성화 실패');
      await page.getByTestId('entry-tp-sl-plan-failed').scrollIntoViewIfNeeded();
      await shot('plans-activation-failed');

      // 5. Conditional BUY: 이상/이하 follows the watch price (never a selector).
      await go('asset=SUI&conditional=enabled&longName=1');
      await page.getByTestId('order-type-select').click();
      await page.getByTestId('order-method-conditional').click();
      await page.getByTestId('conditional-buy-form').waitFor();
      assert.equal(await page.locator('[data-testid^="conditional-trigger-at_or"]').count(), 0, `no 이상/이하 buttons (${tag})`);
      await page.getByTestId('conditional-trigger-price').fill('0.81234567');
      assert.equal(await page.getByTestId('conditional-trigger-direction').innerText(), '감시 조건 · 0.81234567 USD 이하 도달 시', `direction (${tag})`);
      await page.getByTestId('conditional-size').fill('25');
      await page.getByTestId('conditional-trigger-direction').scrollIntoViewIfNeeded();
      await shot('conditional-direction');

      // 6. A Futures position card → its sheet (Long: reduce-only shares).
      await page.goto(`${base}/?screen=futures&viewport=1&fontScale=${fontScale}&futuresPosition=1&plans=enabled&futuresTpSlRows=1`);
      const card = page.getByTestId('futures-position-account-fixture:position-protection');
      await card.waitFor();
      await card.scrollIntoViewIfNeeded();
      await card.click();
      await page.getByTestId('tp-sl-futures-position').waitFor();
      await page.getByTestId('tp-sl-setting-sl-1').waitFor();
      assert.equal(await page.locator('[data-testid^="tp-sl-setting-"][data-testid$="-state"]').count(), 3, `position settings listed (${tag})`);
      await page.getByTestId('tp-sl-live').scrollIntoViewIfNeeded();
      await shot('futures-position-list');
      // Futures Last 102 in the fixture: a Long take-profit above, a stop-loss below
      // (other prices than the listed ones; the stop-loss total stays within 2).
      await fillLegs('130', '90', 25, 25);
      await shot('futures-position-sheet');
      await sheetGeometry('tp-sl-stop-loss-trigger-price');
      assert.deepEqual(errors, [], `${tag} page errors`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failing = report.filter((entry) => entry.issues.length);
  assert.deepEqual(failing, [], 'clipped text or sideways scroll');
  console.log(`손절가/익절가 browser: ${report.length} screens checked, screenshots in ${out}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
