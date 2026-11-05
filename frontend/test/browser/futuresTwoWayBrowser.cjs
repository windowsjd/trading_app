// RN Web check of the two-way futures order screen (2026-11-06): no Last/Mark
// row over the form (the book keeps the price); with a long AND a short held,
// 롱/숏 · 증거금 · 레버리지 stay in the form; a card's top switches the form to
// its contract and side (no order); 수익률 / 평가 기준가 on the cards; another
// leverage shows the change notice and its 레버리지 변경 sheet (server
// estimate, confirm reachable, or no estimate/confirm when it is unknown); a
// held position's other margin mode is explained; 대기 주문 lists futures only.
// No text is cut and nothing scrolls sideways at 320/360/390/430 × light/dark
// × font 1/2. RN Web only — not a device check. Requires esbuild and Playwright
// (see README); FUTURES_TWO_WAY_QUICK=1 checks 320 dark 2x and 390 light 1x only.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.FUTURES_TWO_WAY_BROWSER_OUTPUT ?? '/tmp/trading-futures-two-way';

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
    const ladders = [...document.querySelectorAll('[data-testid="asset-order-book"], [data-testid="futures-order-book-card"]')];
    for (const el of document.querySelectorAll('div, span')) {
      const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (!own || !visible(el) || ladders.some((ladder) => ladder.contains(el))) continue;
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

/** Every word of a button's label inside the button (no line cut off at its edges). */
async function labelInside(page, testID) {
  return page.evaluate((id) => {
    const button = document.querySelector(`[data-testid="${id}"]`);
    if (!button) return [`missing ${id}`];
    const box = button.getBoundingClientRect(), problems = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (const word of node.textContent.matchAll(/\S+/gu)) {
        const range = document.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
        for (const r of range.getClientRects()) {
          if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) problems.push(`${id}: "${word[0]}" outside`);
        }
      }
    }
    return problems;
  }, testID);
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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = [];
  try {
    const combos = [];
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const fontScale of [1, 2]) combos.push([width, appearance, fontScale]);
    for (const [width, appearance, fontScale] of process.env.FUTURES_TWO_WAY_QUICK === '1' ? [[320, 'dark', 2], [390, 'light', 1]] : combos) {
      const height = fontScale === 2 ? 640 : 760;
      const tag = `${width}-${appearance}-${fontScale}x`;
      const open = async (query) => {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
        await page.emulateMedia({ colorScheme: appearance });
        page.errors = [];
        page.on('pageerror', (error) => page.errors.push(error.message));
        await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
        await page.goto(`${base}/?screen=futures&viewport=1&fontScale=${fontScale}&futuresPosition=1&futuresHedge=1${query}`);
        return page;
      };
      const shot = async (page, name) => {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(450);
        const issues = await clipped(page);
        report.push({ shot: `${name}-${tag}`, issues });
        await page.screenshot({ path: path.join(out, `${name}-${tag}.png`) });
      };
      const inside = (box, frame, what) => assert.ok(box && frame && box.y >= frame.y - 1 && box.y + box.height <= frame.y + frame.height + 1
        && box.x >= frame.x - 1 && box.x + box.width <= frame.x + frame.width + 1, `${what} (${tag})`);
      const requests = (page) => page.evaluate(() => window.fixture.state.requests.length);
      const long = 'futures-position-account-fixture:position', short = 'futures-position-account-fixture:hedge';

      const page = await open('');
      const id = (testID) => page.getByTestId(testID);
      await id(long).waitFor();
      await id(short).waitFor();
      // No Last / Mark row over the form; the book keeps the current price.
      assert.equal(await id('futures-prices').count(), 0, `no price row (${tag})`);
      assert.equal(await id('futures-order-book-last').count(), 1, `the book's price (${tag})`);
      // The form keeps 롱/숏, 증거금 and 레버리지 with positions held.
      for (const control of ['futures-direction', 'futures-margin-mode', 'futures-leverage-select', 'order-type-select'])
        assert.equal(await id(control).count() >= 1, true, `${control} (${tag})`);
      for (const card of [long, short]) {
        const text = await id(card).innerText();
        for (const label of ['수익률', '평가 기준가']) assert.equal(text.includes(label), true, `${label} on ${card} (${tag})`);
        for (const gone of ['ROI', 'Mark Price']) assert.equal(text.includes(gone), false, `${gone} gone (${tag})`);
        // The pressable top and the two action buttons are separate targets.
        const top = await id(`${card}-trade`).boundingBox(), tpSl = await id(`${card}-protection`).boundingBox();
        assert.ok(top && tpSl && top.y + top.height <= tpSl.y + 1, `top above the buttons (${tag})`);
        for (const button of [`${card}-protection`, `${card}-close`]) assert.deepEqual(await labelInside(page, button), [], tag);
      }
      await shot(page, 'form-long');
      // The short card's top: the form on 숏 with the short's 10x; nothing ordered.
      const before = await requests(page);
      await id(`${short}-trade`).scrollIntoViewIfNeeded();
      await id(`${short}-trade`).click();
      await page.waitForTimeout(500);
      assert.equal(await requests(page), before, `the tap orders nothing (${tag})`);
      assert.equal((await id('futures-leverage-value').innerText()).trim(), '10x', `the short's leverage (${tag})`);
      assert.match(await id('futures-position-add-hint').innerText(), /보유 숏 포지션에 추가 · 격리 10x/u, `adds to the short (${tag})`);
      const trade = await id('futures-trade').boundingBox();
      assert.ok(trade && trade.y < height, `the form is in view (${tag})`);
      await shot(page, 'form-short');

      // Another leverage: the notice, then 레버리지만 변경's confirmation sheet.
      await id('futures-leverage-select').click();
      await id('futures-leverage-option-50').click();
      await id('futures-leverage-change-notice').waitFor();
      assert.match(await id('futures-leverage-change-notice').innerText(), /10x → 50x/u, `notice (${tag})`);
      assert.deepEqual(await labelInside(page, 'futures-leverage-only'), [], tag);
      await shot(page, 'leverage-notice');
      await id('futures-leverage-only').click();
      await id('futures-leverage-change-confirm').waitFor();
      await page.waitForTimeout(450);
      const sheetText = await id('futures-leverage-change-sheet').innerText();
      for (const part of ['레버리지 변경', '필요 증거금', '주문가능 담보', '예상 청산가', '취소', '레버리지 변경'])
        assert.equal(sheetText.includes(part), true, `${part} (${tag})`);
      assert.match(await id('futures-leverage-change-leverage').innerText(), /10x → 50x/u, tag);
      inside(await id('futures-leverage-change-scroll').boundingBox(), { x: 0, y: 0, width, height }, 'sheet body inside the viewport');
      await id('futures-leverage-change-confirm').scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      inside(await id('futures-leverage-change-confirm').boundingBox(), await id('futures-leverage-change-scroll').boundingBox(), 'confirm reachable');
      for (const button of ['futures-leverage-change-confirm', 'futures-leverage-change-cancel']) assert.deepEqual(await labelInside(page, button), [], tag);
      await shot(page, 'leverage-sheet');
      await id('futures-leverage-change-cancel').click();
      await page.waitForTimeout(450);
      assert.equal(await requests(page), before, `취소 sends nothing (${tag})`);

      // A held position's other margin mode is explained, never sent.
      await id('futures-margin-cross').scrollIntoViewIfNeeded();
      await id('futures-margin-cross').click();
      await id('futures-margin-locked').waitFor();
      await shot(page, 'margin-locked');

      // 대기 주문 on the futures screen: futures rows only.
      assert.deepEqual(page.errors, [], `${tag} page errors`);
      await page.close();

      const pending = await open('&pendingMix=1');
      const pid = (testID) => pending.getByTestId(testID);
      await pid(long).waitFor();
      await pid('futures-view-pending').scrollIntoViewIfNeeded();
      await pid('futures-view-pending').click();
      await pid('pending-list').waitFor();
      await pending.waitForTimeout(800);
      const keys = await pending.evaluate(() => [...document.querySelectorAll('[data-testid^="pending-item-"]')]
        .map((el) => el.getAttribute('data-testid')).filter((key) => /^pending-item-[a-z_]+-[^-]+(-[a-z0-9]+)*$/u.test(key) && !/-(type|registered|edit|cancel|confirm|keep|tp-sl|error|condition|amount|execution|edit-reason)$/u.test(key)));
      assert.equal(keys.some((key) => /spot_|conditional_buy|conditional_sell|spot_stop|spot_take/u.test(key)), false, `no Spot rows (${tag}): ${keys.join(',')}`);
      assert.equal(keys.some((key) => key.startsWith('pending-item-futures_')), true, `futures rows (${tag}): ${keys.join(',')}`);
      await shot(pending, 'pending-futures');
      assert.deepEqual(pending.errors, [], `${tag} pending page errors`);
      await pending.close();

      // An estimate the server cannot give: no values, no confirm.
      const stale = await open('&leveragePreview=stale');
      const sid = (testID) => stale.getByTestId(testID);
      await sid(long).waitFor();
      await sid('futures-leverage-select').click();
      await sid('futures-leverage-option-50').click();
      await sid('futures-leverage-only').click();
      await sid('futures-leverage-change-unknown').waitFor();
      assert.equal(await sid('futures-leverage-change-confirm').getAttribute('aria-disabled'), 'true', `no confirm (${tag})`);
      assert.equal((await sid('futures-leverage-change-margin').innerText()).trim(), '-', `no guessed value (${tag})`);
      await shot(stale, 'leverage-unknown');
      assert.deepEqual(stale.errors, [], `${tag} stale page errors`);
      await stale.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failing = report.filter((entry) => entry.issues.length);
  assert.deepEqual(failing, [], 'clipped text or sideways scroll');
  console.log(`futures two-way screen: ${report.length} screens checked, screenshots in ${out}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
