// Optional real RN Web check of the 주문방식 sheet (with its method icons), conditional/LOC forms,
// the one pending list (통합 대기목록: order, kinds, 설정 변경 / 설정 취소, 종료 이력) and the
// real-fill banner: screenshots at 320/360/390/430px, light/dark and 1x/1.5x/2x fonts, plus a
// clipped-text and page-overflow detector. Requires external esbuild and Playwright (see README);
// ORDER_METHOD_QUICK=1 checks 360 light 1x and 320 dark 2x only.
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
      // The ⓘ beside a Spot condition's price (2026-11-06): its sheet reads the agreed copy, sits
      // inside the viewport, and closes with the typed price kept.
      const priceInfo = async (field, label, title, body, value, name) => {
        const info = page.getByTestId(`${field}-info`);
        // Right beside its field title, on the title's line.
        const labelBox = await page.getByText(label, { exact: true }).first().boundingBox();
        const infoBox = await info.boundingBox();
        assert.ok(infoBox.x >= labelBox.x + labelBox.width - 1 && infoBox.x - (labelBox.x + labelBox.width) <= 12
          && Math.abs(infoBox.y + infoBox.height / 2 - (labelBox.y + labelBox.height / 2)) <= 8, `${field} ⓘ beside ${label} (${tag})`);
        await info.click();
        await page.getByTestId(`${field}-info-body`).waitFor();
        await page.waitForTimeout(450);
        const sheet = await page.getByTestId(`${field}-info-sheet`).innerText();
        assert.ok(sheet.includes(title), `${field} title (${tag})`);
        assert.equal(await page.getByTestId(`${field}-info-body`).innerText(), body.join('\n'), `${field} body (${tag})`);
        assert.equal(/보장|체결되지 않을 수/u.test(sheet), false, `${field} no fill caveat (${tag})`);
        const box = await page.getByTestId(`${field}-info-body`).boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1 && box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, `${field} sheet on screen (${tag})`);
        await shot(name);
        await page.getByTestId(`${field}-info-sheet-close`).click();
        await page.getByTestId(`${field}-info-body`).waitFor({ state: 'detached' });
        assert.equal(await page.getByTestId(field).inputValue(), value, `${field} kept (${tag})`);
      };

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
      await priceInfo('conditional-trigger-price', '감시가격 (USD)', '감시가격이란?', [
        '감시가격은 자동으로 매수·매도 주문을 시작하는 기준가격입니다.',
        '시세가 설정한 방향에 따라 감시가격 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
      ], '0.81234567', 'crypto-conditional-price-info');
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

      // 4. KRX SELL: market plus the server-gated 조건주문 and LOC rows; no new
      // 지정가 (2026-11-05) and no 손절가/익절가 row (it lives on the holding card).
      await go('krx=1&asset=SAMSUNG&longName=1');
      await page.getByTestId('asset-detail-sell-button').click();
      await defaultField();
      await field().click();
      await row('loc').waitFor();
      assert.equal(await row('limit').count(), 0, `no new SELL limit (${tag})`);
      assert.equal(await row('protection').count(), 0, 'no 손절가/익절가 주문방식');
      await shot('krx-sell-sheet');
      await sheetReachable(['market', 'conditional', 'loc']);
      await page.getByTestId('order-method-sheet-close').click();

      // 4a. Limits registered AND matched still add no SELL 지정가 row.
      await go('krx=1&asset=SAMSUNG&longName=1&limitSell=enabled&stock=1&holding=10&reserved=4');
      await page.getByTestId('asset-detail-sell-button').click();
      await field().click();
      await row('loc').waitFor();
      assert.equal(await row('limit').count(), 0, `no SELL limit with matching on (${tag})`);
      await page.getByTestId('order-method-sheet-close').click();

      // 4b'. KRX closed: a conditional BUY takes a chosen 이상/이하 (none preselected);
      // market-execution ratio picks are off without a current price, a limit
      // price restores them; the result says watching starts next session.
      await go('krx=1&krxClosed=1&asset=SAMSUNG&conditional=enabled&offSession=1&longName=1&stock=1');
      await field().click();
      await row('conditional').click();
      await page.getByTestId('conditional-buy-form').waitFor();
      assert.equal(await page.getByTestId('conditional-off-session-notice').innerText(),
        '정규장 외 시간입니다. 감시 방향을 선택하면 조건주문을 등록할 수 있으며, 다음 정규장부터 감시합니다.', `off-session notice (${tag})`);
      for (const condition of ['at_or_above', 'at_or_below'])
        assert.equal(await page.getByTestId(`conditional-trigger-${condition}`).getAttribute('aria-checked'), 'false', `${condition} not preselected (${tag})`);
      await page.getByTestId('conditional-trigger-price').fill('72000');
      await page.getByTestId('conditional-trigger-at_or_above').click();
      assert.equal(await page.getByTestId('conditional-trigger-direction').innerText(), '감시 조건 · 72000 KRW 이상 도달 시', `chosen direction (${tag})`);
      assert.equal(await page.getByTestId('conditional-ratio-reason').count(), 1, `market ratio off while closed (${tag})`);
      await shot('krx-closed-conditional');
      await page.getByTestId('conditional-execution-limit').click();
      await page.getByTestId('conditional-limit-price').fill('72500');
      await page.getByTestId('conditional-ratio-100').click();
      assert.ok(Number(await page.getByTestId('conditional-size').inputValue()) >= 1, `limit ratio sizes the watch (${tag})`);
      await page.getByTestId('conditional-ratio').scrollIntoViewIfNeeded();
      await shot('krx-closed-conditional-ratio');
      await page.getByTestId('conditional-submit').click();
      await page.getByTestId('conditional-registered').waitFor();
      assert.ok((await page.getByTestId('conditional-registered-title').innerText()).includes('다음 정규장부터 감시합니다'), `off-session result (${tag})`);
      await page.getByTestId('conditional-registered').scrollIntoViewIfNeeded();
      await shot('krx-closed-conditional-registered');

      // 4c. KRX closed: a SELL condition takes a chosen direction and a share of the holding.
      await go('krx=1&krxClosed=1&asset=SAMSUNG&sell=enabled&offSession=1&stock=1&holding=10&longName=1');
      await page.getByTestId('asset-detail-sell-button').click();
      await field().click();
      await row('conditional').click();
      await page.getByTestId('sell-condition-form').waitFor();
      await page.getByTestId('sell-condition-trigger-price').fill('65000');
      await page.getByTestId('sell-trigger-at_or_below').click();
      await page.getByTestId('sell-condition-ratio-50').click();
      assert.equal(await page.getByTestId('sell-condition-quantity').inputValue(), '5', `50% of 10 held (${tag})`);
      await page.getByTestId('sell-condition-ratio').scrollIntoViewIfNeeded();
      await shot('krx-closed-sell-condition');
      await page.getByTestId('sell-condition-trigger-price-info').scrollIntoViewIfNeeded();
      await priceInfo('sell-condition-trigger-price', '매도 기준가 (KRW)', '매도 기준가란?', [
        '매도 기준가는 자동으로 매도 주문을 시작하는 기준가격입니다.',
        '시세가 설정한 방향에 따라 매도 기준가 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
      ], '65000', 'krx-sell-price-info');

      // 4d. KRX open: the direction follows the price; ratio picks size the watch.
      await go('krx=1&asset=SAMSUNG&conditional=enabled&longName=1&stock=1');
      await field().click();
      await row('conditional').click();
      await page.getByTestId('conditional-trigger-price').fill('69000');
      assert.equal(await page.getByTestId('conditional-trigger-direction').innerText(), '감시 조건 · 69000 KRW 이하 도달 시', `auto direction (${tag})`);
      assert.equal(await page.locator('[data-testid^="conditional-trigger-at_or"]').count(), 0, `no chosen direction in session (${tag})`);
      await page.getByTestId('conditional-ratio-50').click();
      assert.ok(Number(await page.getByTestId('conditional-size').inputValue()) > 0, `50% sizes the watch (${tag})`);
      await page.getByTestId('conditional-ratio').scrollIntoViewIfNeeded();
      await shot('krx-conditional-ratio');

      // 4b. US stocks once the server lists US (US_STOCK_PRICE_PROVIDER=tiingo,
      // 2026-10-17): 조건주문 and LOC open like KRX, the LOC form shows the
      // New York session (in KST) and the official price is never "체험".
      await go('usOfficial=1&asset=AAPL&loc=enabled&locSell=enabled&conditional=enabled&sell=enabled');
      await defaultField();
      assert.equal(await page.getByTestId('asset-trial-price-notice').count(), 0, `no trial notice on official prices (${tag})`);
      await field().click();
      for (const method of ['market', 'limit', 'conditional', 'loc']) {
        await row(method).waitFor();
        assert.equal(await page.getByTestId(`order-method-${method}-badge`).count(), 0, `US ${method} available (${tag})`);
      }
      await shot('us-sheet');
      await sheetReachable(['market', 'limit', 'conditional', 'loc']);
      await row('loc').click();
      await page.getByTestId('loc-order-notice').waitFor();
      await page.getByTestId('order-limit-price-input').fill('247.5');
      await page.getByTestId('order-quantity-input').fill('3');
      await shot('us-loc');
      await page.getByTestId('asset-detail-sell-button').click();
      await field().click();
      for (const method of ['market', 'conditional', 'loc']) {
        await row(method).waitFor();
        assert.equal(await page.getByTestId(`order-method-${method}-badge`).count(), 0, `US sell ${method} available (${tag})`);
      }
      assert.equal(await row('limit').count(), 0, `no US sell limit (${tag})`);
      await shot('us-sell-sheet');
      await page.getByTestId('order-method-sheet-close').click();

      // 5. 통합 대기목록 (2026-11-05; the per-kind tabs are gone): every kind in one list,
      // oldest registration first, each card with its kind's badge and side.
      const cards = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="pending-item-"]')]
        .map((el) => el.getAttribute('data-testid')).filter((id) => document.querySelector(`[data-testid="${id}-registered"]`)));
      const asked = async (id) => (await page.getByTestId(`${id}-confirm`).innerText()).split('\n')[0].trim();
      const sent = (suffix) => page.evaluate((end) => window.fixture.state.requests.filter((r) => r.path.endsWith(end))
        .map((r) => ({ path: r.path, body: r.body ?? null })), suffix);
      await go('krx=1&asset=SAMSUNG&stock=1&holding=10&longName=1&pendingMix=1&conditional=enabled&sell=enabled');
      await page.getByTestId('holdings-filter-pending').click();
      await page.getByTestId('pending-count').waitFor();
      // [card, badge, side line, 설정 취소 question] in registration order (09:00–09:06 KST).
      const mix = [
        ['futures_limit-mix-fl', '선물 지정가', '롱 진입 · 격리 5x', '선물 지정가 진입 주문을 취소할까요?'],
        ['spot_limit-mix-sell-limit', '지정가', '매도', '지정가 매도 주문을 취소할까요?'],
        ['conditional_buy-mix-cb', '조건주문', '매수', '조건부 매수 설정을 취소할까요?'],
        ['spot_take_profit-mix-tp', '익절가/손절가', '매도 · 익절가', '익절가 매도 설정을 취소할까요?'],
        ['spot_limit-mix-buy-limit', '지정가', '매수', '지정가 매수 주문을 취소할까요?'],
        ['conditional_sell-mix-cs', '조건주문', '매도', '조건부 매도 설정을 취소할까요?'],
        ['spot_stop_loss-mix-sl', '익절가/손절가', '매도 · 손절가', '손절가 매도 설정을 취소할까요?'],
      ];
      assert.deepEqual(await cards(), mix.map(([key]) => `pending-item-${key}`), `registration order (${tag})`);
      // Still registration order (above), without saying so (2026-11-06).
      assert.equal(await page.getByTestId('pending-count').innerText(), `대기 ${mix.length}건`, `count (${tag})`);
      // Plain Spot limits: their direction of reach, and no reservation line on the card.
      assert.equal(await page.getByTestId('pending-item-spot_limit-mix-buy-limit-condition').innerText().then((text) => /지정가 .+ 이하 도달/u.test(text)), true, `buy limit condition (${tag})`);
      assert.equal(await page.getByTestId('pending-item-spot_limit-mix-sell-limit-condition').innerText().then((text) => /지정가 .+ 이상 도달/u.test(text)), true, `sell limit condition (${tag})`);
      assert.equal(await page.getByTestId('pending-item-spot_limit-mix-buy-limit').innerText().then((text) => text.includes('예약 금액')), false, `no 예약 금액 (${tag})`);
      for (const [index, [key, badge, side]] of mix.entries()) {
        assert.equal((await page.getByTestId(`pending-item-${key}-type`).innerText()).trim(), badge, `${key} badge (${tag})`);
        assert.equal(await page.getByTestId(`pending-item-${key}-registered`).innerText(), `등록 2026-11-05 09:0${index}`, `${key} time (${tag})`);
        assert.ok((await page.getByTestId(`pending-item-${key}`).innerText()).includes(side), `${key} side (${tag})`);
      }
      // Spot SELL settings read 매도 기준가; the BUY watch keeps 감시가격.
      for (const key of ['spot_take_profit-mix-tp', 'conditional_sell-mix-cs', 'spot_stop_loss-mix-sl'])
        assert.ok((await page.getByTestId(`pending-item-${key}-condition`).innerText()).includes('매도 기준가'), `${key} term (${tag})`);
      assert.ok((await page.getByTestId('pending-item-conditional_buy-mix-cb-condition').innerText()).includes('감시가격 68,000원 이하'), `BUY term (${tag})`);
      await page.getByTestId('pending-list').scrollIntoViewIfNeeded();
      await shot('pending-list');

      // 5a. A 익절가/손절가 card opens its own 설정 변경 on its current terms (the sheet's
      // ratio and review: pendingTpSlEditBrowser.cjs).
      const closeSheet = async () => {
        await page.getByTestId('pending-edit-sheet-close').click();
        await page.waitForTimeout(450);
      };
      await page.getByTestId('pending-item-spot_take_profit-mix-tp-edit').scrollIntoViewIfNeeded();
      await page.getByTestId('pending-item-spot_take_profit-mix-tp-edit').click();
      await page.getByTestId('pending-edit-quantity-ratio').waitFor();
      assert.equal(await page.getByTestId('pending-edit-trigger-price').inputValue(), '75000', `TP price (${tag})`);
      assert.equal(await page.getByTestId('pending-edit-quantity').inputValue(), '1.5', `TP quantity (${tag})`);
      await shot('pending-tp-edit');
      await closeSheet();

      // 5b. The KRX conditional BUY at market (3.164126주): at 지정가 the sheet asks for whole
      // shares and keeps the fraction as typed; back at 시장가 a 감시가격-only change saves
      // as ONE modify carrying the fraction unchanged.
      const cb = 'pending-item-conditional_buy-mix-cb';
      assert.ok((await page.getByTestId(`${cb}-amount`).innerText()).includes('3.164126주'), `BUY quantity (${tag})`);
      await page.getByTestId(`${cb}-edit`).scrollIntoViewIfNeeded();
      await page.getByTestId(`${cb}-edit`).click();
      await page.getByTestId('pending-edit-execution-limit').waitFor();
      assert.equal(await page.getByTestId('pending-edit-quantity').inputValue(), '3.164126', `BUY registered quantity (${tag})`);
      await page.getByTestId('pending-edit-execution-limit').click();
      await page.getByTestId('pending-edit-quantity-whole').waitFor();
      assert.equal(await page.getByTestId('pending-edit-quantity-whole').innerText(),
        '소수점 수량은 시장가로만 실행돼요. 지정가로 실행하려면 수량을 정수로 수정해 주세요.', `whole-share guidance (${tag})`);
      assert.equal(await page.getByTestId('pending-edit-quantity').inputValue(), '3.164126', `fraction kept (${tag})`);
      await page.getByTestId('pending-edit-quantity-whole').scrollIntoViewIfNeeded();
      await shot('pending-buy-limit-whole');
      await page.getByTestId('pending-edit-execution-market').click();
      await page.getByTestId('pending-edit-quantity-whole').waitFor({ state: 'detached' });
      await page.getByTestId('pending-edit-trigger-price').fill('67000');
      await page.getByTestId('pending-edit-review').scrollIntoViewIfNeeded();
      await page.getByTestId('pending-edit-review').click();
      await page.getByTestId('pending-edit-changes').waitFor();
      const changes = await page.getByTestId('pending-edit-changes').innerText();
      assert.ok(changes.includes('68,000원') && changes.includes('67,000원') && !changes.includes('수량'), `price-only change (${tag})`);
      await shot('pending-buy-review');
      await page.getByTestId('pending-edit-save').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pending-notice"]')?.textContent.includes('변경했어요'));
      const modified = await sent('/modify');
      assert.deepEqual(modified.map((r) => r.path), ['/trading-accounts/account-fixture/conditional-buy-orders/mix-cb/modify'], `one modify (${tag})`);
      const { triggerPrice, executionType, quantity, expectedRevision } = modified[0].body;
      assert.deepEqual([triggerPrice, executionType, quantity, expectedRevision], ['67000', 'market', '3.164126', 1], `the fraction is sent unchanged (${tag})`);
      await page.waitForTimeout(450);

      // 5c. 설정 취소 asks one short question naming what ends (no reservation
      // explanation); 유지 keeps it; 취소하기 sends that one cancel.
      for (const [key, , , question] of mix) {
        const id = `pending-item-${key}`;
        await page.getByTestId(`${id}-cancel`).scrollIntoViewIfNeeded();
        await page.getByTestId(`${id}-cancel`).click();
        await page.getByTestId(`${id}-confirm`).waitFor();
        assert.equal(await asked(id), question, `${key} confirm (${tag})`);
        if (key === 'spot_take_profit-mix-tp') await shot('pending-cancel-confirm');
        await page.getByTestId(`${id}-keep`).click();
        await page.getByTestId(`${id}-confirm`).waitFor({ state: 'detached' });
      }
      assert.deepEqual(await sent('/cancel'), [], `유지 sends nothing (${tag})`);
      await page.getByTestId('pending-item-conditional_sell-mix-cs-cancel').click();
      await page.getByTestId('pending-item-conditional_sell-mix-cs-confirm-cancel').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="pending-notice"]')?.textContent.includes('취소했어요'));
      assert.deepEqual((await sent('/cancel')).map((r) => r.path), ['/trading-accounts/account-fixture/conditional-sell-orders/mix-cs/cancel'], `one cancel (${tag})`);

      // 5d. Conditional BUY watches in every state: open ones are cards (triggered and
      // order_pending say why they cannot change; order_pending cancels the order it
      // placed), ended ones are only in 종료 이력.
      await go('asset=SUI&conditional=enabled&conditionalRows=1&longName=1');
      await page.getByTestId('holdings-filter-pending').click();
      const watch = (s) => `pending-item-conditional_buy-cb-${s}`;
      for (const s of ['watching', 'triggered', 'order_pending']) await page.getByTestId(watch(s)).waitFor();
      for (const s of ['filled', 'failed', 'canceled', 'order_canceled', 'order_rejected'])
        assert.equal(await page.getByTestId(watch(s)).count(), 0, `${s} is not pending (${tag})`);
      assert.ok((await page.getByTestId(`${watch('triggered')}-edit-reason`).innerText()).includes('조건이 충족되어 주문을 처리하고 있어요'), `triggered reason (${tag})`);
      assert.ok((await page.getByTestId(`${watch('order_pending')}-edit-reason`).innerText()).includes('접수된 지정가 주문은 변경할 수 없어요'), `order_pending reason (${tag})`);
      await page.getByTestId(`${watch('order_pending')}-cancel`).scrollIntoViewIfNeeded();
      await page.getByTestId(`${watch('order_pending')}-cancel`).click();
      assert.equal(await asked(watch('order_pending')), '조건부 매수로 접수된 지정가 매수 주문을 취소할까요?', `child order confirm (${tag})`);
      await page.getByTestId('pending-list').scrollIntoViewIfNeeded();
      await shot('conditional-list');
      await page.getByTestId(`${watch('order_pending')}-keep`).click();
      // 5e. Old open rows behind 35 newer ended rows are all listed (the open read pages
      // `state=open` itself); 종료 이력 shows the newest 30 of the kind (유형별 최근 30건 —
      // the one history has no further pages); a cancel that lost its race shows
      // reviewed copy, never the server's raw text.
      await go('asset=SUI&conditional=enabled&conditionalRows=many&longName=1&conditionalCancel=fail');
      await page.getByTestId('holdings-filter-pending').click();
      for (const s of ['order_pending', 'triggered', 'watching']) await page.getByTestId(`pending-item-conditional_buy-old-${s}`).waitFor();
      assert.equal(await page.getByTestId('pending-count').innerText(), '대기 3건', `old open rows listed (${tag})`);
      await page.getByTestId('pending-history-toggle').scrollIntoViewIfNeeded();
      await page.getByTestId('pending-history-toggle').click();
      await page.getByTestId('pending-history').waitFor();
      assert.equal(await page.locator('[data-testid^="pending-history-conditional_buy-"]:not([data-testid$="-state"]):not([data-testid$="-reason"])').count(),
        30, `newest 30 ended rows (${tag})`);
      await page.getByTestId('pending-history').scrollIntoViewIfNeeded();
      await shot('pending-history');
      const old = 'pending-item-conditional_buy-old-watching';
      await page.getByTestId(`${old}-cancel`).scrollIntoViewIfNeeded();
      await page.getByTestId(`${old}-cancel`).click();
      await page.getByTestId(`${old}-confirm-cancel`).click();
      await page.getByTestId(`${old}-error`).waitFor();
      const cancelError = await page.getByTestId(`${old}-error`).innerText();
      assert.ok(cancelError.includes('이미 주문이 만들어진 조건주문입니다') && !cancelError.includes('raw server text'), `cancel error copy (${tag})`);
      await page.getByTestId(`${old}-error`).scrollIntoViewIfNeeded();
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
