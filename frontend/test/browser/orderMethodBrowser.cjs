// Optional real RN Web check of the 주문방식 sheet (with its method icons), conditional/LOC forms,
// the conditional list and the real-fill banner: screenshots at 320/360/390/430px,
// light/dark and 1x/1.5x/2x fonts, plus a clipped-text and page-overflow detector.
// Requires external esbuild and Playwright (see README).
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.ORDER_METHOD_BROWSER_OUTPUT ?? '/tmp/trading-order-method-browser';

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
    // The order-book ladder (price column) already overflows at 320px / large
    // fonts at HEAD; it is reported separately, not attributed to this UI.
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
    const quick = process.env.ORDER_METHOD_QUICK === '1';
    const combos = [];
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const fontScale of [1, 1.5, 2]) combos.push([width, appearance, fontScale]);
    for (const [width, appearance, fontScale] of quick ? [[360, 'light', 1], [320, 'dark', 2]] : combos) {
      const page = await browser.newPage({ viewport: { width, height: 760 } });
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
      const go = async (query) => {
        await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&${query}`);
        await page.getByTestId('order-type-select').waitFor();
      };
      const field = () => page.getByTestId('order-type-select');
      // A new form reads 시장가 on the left; a large ▼ sits at the field's right
      // edge inside it; no 「주문방식 선택하기」 hint (2026-10-16).
      const defaultField = async () => {
        assert.equal(await page.getByTestId('order-type-select-value').innerText(), '시장가', `default method (${tag})`);
        assert.equal(await page.getByTestId('order-type-select-hint').count(), 0, `no hint (${tag})`);
        const box = await field().boundingBox();
        const triangle = await page.getByTestId('order-type-select-chevron').boundingBox();
        const value = await page.getByTestId('order-type-select-value').boundingBox();
        assert.ok(triangle.x >= box.x && triangle.x + triangle.width <= box.x + box.width + 1 && triangle.y >= box.y && triangle.y + triangle.height <= box.y + box.height + 1, `▼ inside the field (${tag})`);
        assert.ok(box.x + box.width - (triangle.x + triangle.width) <= 28, `▼ at the field's right (${tag})`);
        assert.ok(triangle.x >= value.x + value.width - 1, `▼ after the value (${tag})`);
      };
      // Every row of the open sheet can be brought fully inside the sheet card and the viewport.
      const sheetReachable = async (methods) => {
        const card = await page.getByTestId('order-method-list').boundingBox();
        for (const method of methods) {
          await page.getByTestId(`order-method-${method}`).scrollIntoViewIfNeeded();
          await page.waitForTimeout(50);
          const box = await page.getByTestId(`order-method-${method}`).boundingBox();
          const list = await page.getByTestId('order-method-list').boundingBox();
          assert.ok(box.y >= list.y - 1 && box.y + box.height <= list.y + list.height + 1, `${method} inside the sheet (${tag})`);
          assert.ok(box.y + box.height <= (page.viewportSize().height) + 1, `${method} inside the viewport (${tag})`);
        }
        assert.ok(card.y >= 0, `sheet top on screen (${tag})`);
        await page.getByTestId(`order-method-${methods[0]}`).scrollIntoViewIfNeeded();
      };
      const row = (method) => page.getByTestId(`order-method-${method}`);

      // 1. Crypto BUY: 시장가 by default with the ▼ on the field's right, then
      // the sheet with a server-gated 조건주문.
      await go('asset=SUI&conditional=enabled&longName=1');
      await defaultField();
      assert.equal(await page.getByTestId('order-quantity-input').count(), 1, 'the market draft is ready');
      await shot('crypto-default');
      await field().click();
      await row('market').waitFor();
      assert.equal(await row('loc').count(), 0, 'crypto never lists LOC');
      assert.equal(await row('limit').count(), 1);
      await shot('crypto-sheet');
      await sheetReachable(['market', 'limit', 'conditional']);
      // 2. Conditional form with watch and limit prices.
      await row('conditional').click();
      await page.getByTestId('conditional-buy-form').waitFor();
      // 이상/이하 follows the watch price against SUI 0.8592 (no selector).
      await page.getByTestId('conditional-trigger-price').fill('0.81234567');
      assert.equal(await page.getByTestId('conditional-trigger-direction').innerText(), '감시 조건 · 0.81234567 USD 이하 도달 시', `direction (${tag})`);
      await page.getByTestId('conditional-execution-limit').click();
      await page.getByTestId('conditional-limit-price').fill('0.80123456');
      await page.getByTestId('conditional-size').fill('1234567.12345678');
      await shot('crypto-conditional');
      await page.getByTestId('conditional-submit').click();
      await page.getByTestId('conditional-registered').waitFor();
      await page.getByTestId('conditional-registered').scrollIntoViewIfNeeded();
      await shot('crypto-conditional-registered');
      // 2b. A same-key replay answers with the watch as it is now: its state, not 감시 중.
      for (const [result, title] of [['order_pending', '지정가 매수가 접수됐어요'], ['failed', '주문을 실행하지 못했어요']]) {
        await go(`asset=SUI&conditional=enabled&longName=1&conditionalResult=${result}`);
        await field().click();
        await row('conditional').click();
        await page.getByTestId('conditional-trigger-price').fill('0.81234567');
        await page.getByTestId('conditional-execution-limit').click();
        await page.getByTestId('conditional-limit-price').fill('0.80123456');
        await page.getByTestId('conditional-size').fill('1234567.12345678');
        await page.getByTestId('conditional-submit').click();
        await page.getByTestId('conditional-registered').waitFor();
        const text = await page.getByTestId('conditional-registered').innerText();
        assert.ok(text.includes(title) && !text.includes('감시 중입니다'), `${result} replay copy (${tag})`);
        await page.getByTestId('conditional-registered').scrollIntoViewIfNeeded();
        await shot(`conditional-replay-${result}`);
      }

      // 3. KRX BUY: 시장가 by default; four methods, LOC form with its policy notice.
      await go('krx=1&asset=SAMSUNG&loc=enabled&conditional=enabled&longName=1');
      await defaultField();
      await shot('krx-default');
      await field().click();
      for (const method of ['market', 'limit', 'conditional', 'loc']) await row(method).waitFor();
      await shot('krx-sheet');
      await sheetReachable(['market', 'limit', 'conditional', 'loc']);
      // Each method has its own stroked line icon (2026-10-16): 시장가 bolt, 지정가
      // target, 조건주문 bell, LOC clock, in the appearance palette's tone (never a
      // StyleSheet sentinel), inside its circle and left of the method name.
      const icons = await page.evaluate(() => [['market', '시장가'], ['limit', '지정가'], ['conditional', '조건주문'], ['loc', 'LOC 주문']].map(([method, label]) => {
        const icon = document.querySelector(`[data-testid="order-method-${method}-icon"]`), svg = icon?.querySelector('svg');
        const row = document.querySelector(`[data-testid="order-method-${method}"]`);
        const title = [...row.querySelectorAll('div, span')].find((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === label));
        const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
        return { method, d: svg ? [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')).join(' ') : '', stroke: (svg?.getAttribute('stroke') ?? '').toLowerCase(),
          text: icon?.textContent.trim() ?? null, icon: icon && box(icon), svg: svg && box(svg), row: box(row), title: title && box(title) };
      }));
      const tones = { light: { market: '#166534', limit: '#245b76', conditional: '#245b76', loc: '#725400' }, dark: { market: '#79d68b', limit: '#9acbe2', conditional: '#9acbe2', loc: '#e8bf69' } }[appearance];
      assert.equal(new Set(icons.map((icon) => icon.d)).size, 4, `four different icons (${tag})`);
      for (const { method, d, stroke, text, icon, svg, row: line, title } of icons) {
        assert.ok(d && svg && icon && title, `${method} icon and name rendered (${tag})`);
        assert.equal(text, '', `${method}: no glyph text (${tag})`);
        assert.equal(stroke, tones[method], `${method}: palette stroke (${tag})`);
        assert.ok(svg[0] >= icon[0] - 0.5 && svg[1] >= icon[1] - 0.5 && svg[2] <= icon[2] + 0.5 && svg[3] <= icon[3] + 0.5, `${method}: icon inside its circle (${tag})`);
        assert.ok(icon[0] >= line[0] && icon[2] <= title[0], `${method}: icon left of the name, no overlap (${tag})`);
      }
      await row('loc').click();
      await page.getByTestId('loc-order-notice').waitFor();
      assert.equal(await page.getByTestId('order-tp-sl-button').count(), 0, `LOC takes no 손절가/익절가 (${tag})`);
      await page.getByTestId('order-limit-price-input').fill('70000');
      await page.getByTestId('order-quantity-input').fill('2');
      await shot('krx-loc');

      // 4. KRX SELL: market plus the server-gated 조건주문/LOC rows; no direct limit and
      // no 손절가/익절가 row (it lives on the holding card).
      await go('krx=1&asset=SAMSUNG&longName=1');
      await page.getByTestId('asset-detail-sell-button').click();
      await defaultField();
      await field().click();
      await row('loc').waitFor();
      assert.equal(await row('limit').count(), 0, 'no new sell limit');
      assert.equal(await row('protection').count(), 0, 'no 손절가/익절가 주문방식');
      await shot('krx-sell-sheet');
      await sheetReachable(['market', 'conditional', 'loc']);
      await page.getByTestId('order-method-sheet-close').click();

      // 5. The account's conditional orders with every state.
      await go('asset=SUI&conditional=enabled&conditionalRows=1');
      await page.getByTestId('holdings-filter-pending').click();
      await page.getByTestId('pending-kind-conditional').click();
      await page.getByTestId('conditional-orders-list').waitFor();
      await page.getByTestId('conditional-orders-list').scrollIntoViewIfNeeded();
      await shot('conditional-list');
      // 5b. Old open rows behind 35 newer ended rows: all open rows listed, history pages,
      // and a cancel that lost its race shows reviewed copy (never the raw server text).
      await go('asset=SUI&conditional=enabled&conditionalRows=many&longName=1&alertConfirm=1&conditionalCancel=fail');
      await page.getByTestId('holdings-filter-pending').click();
      await page.getByTestId('pending-kind-conditional').click();
      await page.getByTestId('conditional-orders-open').waitFor();
      const rowsIn = (section) => page.getByTestId(`conditional-orders-${section}`).locator('[data-testid^="conditional-order-"]:not([data-testid$="-state"]):not([data-testid$="-cancel"])').count();
      assert.equal(await rowsIn('open'), 3, `old open rows listed (${tag})`);
      await page.getByTestId('conditional-orders-more').waitFor();
      assert.equal(await rowsIn('ended'), 30, `first history page (${tag})`);
      await page.getByTestId('conditional-orders-open').scrollIntoViewIfNeeded();
      await shot('conditional-open');
      await page.getByTestId('conditional-orders-more').click();
      await page.getByTestId('conditional-orders-more').waitFor({ state: 'detached' });
      assert.equal(await rowsIn('ended'), 35, `all history after 더 보기 (${tag})`);
      await page.getByTestId('conditional-order-old-watching-cancel').click();
      await page.getByTestId('conditional-orders-cancel-error').waitFor();
      const cancelError = await page.getByTestId('conditional-orders-cancel-error').innerText();
      assert.ok(cancelError.includes('이미 주문이 만들어진 조건주문입니다') && !cancelError.includes('raw server text'), `cancel error copy (${tag})`);
      await page.getByTestId('conditional-orders-cancel-error').scrollIntoViewIfNeeded();
      await shot('conditional-cancel-error');

      // 6. The real-fill banner over the order screen.
      await go('krx=1&asset=SAMSUNG&fillBanner=1&longName=1');
      await page.getByTestId('order-fill-banner').waitFor();
      await shot('fill-banner');
      // 6b. 내역 보기 held by a beginner guide: the banner stays and says why.
      await go('krx=1&asset=SAMSUNG&fillBanner=1&longName=1&fillHistory=held');
      await page.getByTestId('order-fill-banner-history').click();
      await page.getByTestId('order-fill-banner-not-opened').waitFor();
      await shot('fill-banner-held');
      await page.waitForTimeout(4200);
      assert.equal(await page.getByTestId('order-fill-banner-not-opened').isVisible(), true, `held banner stays past its usual time (${tag})`);
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
  console.log(`order method browser: ${report.length} screens checked, screenshots in ${out}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
