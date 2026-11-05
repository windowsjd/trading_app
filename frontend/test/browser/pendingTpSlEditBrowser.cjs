// RN Web check of a Spot stop-loss card and its 설정 변경 sheet (2026-11-05): the
// card reads 익절가/손절가 · 매도 · 손절가 with 매도 기준가 and no 최대; the sheet
// opens on the registered quantity with its share of the holding, the ratio
// picks write a share (the input keeps what is typed), and the review is
// reachable. Crypto (SUI) and a KRX stock, long names and quantities. No text is
// cut and nothing scrolls sideways at 320/360/390/430 × light/dark × font 1/2.
// RN Web only — not a device check (no soft keyboard, no native slider
// gesture). Requires esbuild and Playwright (see README);
// PENDING_TP_SL_QUICK=1 checks 320 dark 2x and 390 light 1x only.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.PENDING_TP_SL_BROWSER_OUTPUT ?? '/tmp/trading-pending-tp-sl-edit';

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
    // The order-book ladder already overflows at 320px / large fonts at HEAD. So
    // does 내 보유's 평가손익 at 320px / 2x with this fixture's 2.47M-share KRX
    // holding (+10,370,363,837원; same box on a git-archive HEAD copy, 2026-11-05).
    const ladder = document.querySelector('[data-testid="asset-order-book"]');
    const pnl = [...document.querySelectorAll('[data-testid="order-holding-pnl-value"]')];
    for (const el of document.querySelectorAll('div, span')) {
      const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
      if (!own || !visible(el) || ladder?.contains(el) || pnl.some((value) => value.contains(el))) continue;
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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = [];
  try {
    const combos = [];
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const fontScale of [1, 2]) combos.push([width, appearance, fontScale]);
    for (const [width, appearance, fontScale] of process.env.PENDING_TP_SL_QUICK === '1' ? [[320, 'dark', 2], [390, 'light', 1]] : combos) {
      for (const market of ['crypto', 'krx']) {
        const height = fontScale === 2 ? 640 : 760;
        const page = await browser.newPage({ viewport: { width, height } });
        await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
        await page.emulateMedia({ colorScheme: appearance });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
        const tag = `${market}-${width}-${appearance}-${fontScale}x`;
        const id = (testID) => page.getByTestId(testID);
        const shot = async (name) => {
          // Let sheet/press motion settle (rows count as visible while still sliding).
          await page.mouse.move(0, 0);
          await page.waitForTimeout(450);
          const issues = await clipped(page);
          report.push({ shot: `${name}-${tag}`, issues });
          await page.screenshot({ path: path.join(out, `${name}-${tag}.png`) });
        };
        const inside = (box, frame, what) => assert.ok(box && frame && box.y >= frame.y - 1 && box.y + box.height <= frame.y + frame.height + 1
          && box.x >= frame.x - 1 && box.x + box.width <= frame.x + frame.width + 1, `${what} (${tag})`);
        // 1,234,567.123456 of 2,469,134.246912 held: exactly 50%.
        const stock = market === 'krx' ? '&krx=1&asset=SAMSUNG&stock=1' : '';
        await page.goto(`${base}/?screen=order&viewport=1&fontScale=${fontScale}&longName=1&sell=enabled&sellRows=1&holding=2469134.246912${stock}`);
        await id('order-type-select').waitFor();
        const holdingButton = market === 'krx' ? 'holding-SAMSUNG-tp-sl' : 'holding-SUI-tp-sl';
        await id(holdingButton).first().waitFor();
        assert.equal((await id(holdingButton).first().innerText()).trim(), '익절가/손절가 설정', `holding button (${tag})`);
        await id('holdings-filter-pending').click();
        const card = 'pending-item-spot_stop_loss-stop_loss-watching';
        await id(card).waitFor();
        await id(card).scrollIntoViewIfNeeded();
        assert.equal((await id(`${card}-type`).innerText()).trim(), '익절가/손절가', `badge (${tag})`);
        const cardText = await id(card).innerText();
        assert.ok(cardText.includes('매도 · 손절가') && cardText.includes('매도 기준가') && !/최대|감시가격/u.test(cardText), `card copy (${tag})`);
        await shot('card');

        await id(`${card}-edit`).click();
        await id('pending-edit-quantity-ratio').waitFor();
        await page.waitForTimeout(450);
        assert.equal(await id('pending-edit-quantity').inputValue(), '1234567.123456', `registered quantity (${tag})`);
        assert.equal((await id('pending-edit-quantity-ratio-percent').innerText()).trim(), '50%', `its share (${tag})`);
        const sheetText = await id('pending-edit-sheet').innerText();
        assert.ok(sheetText.includes('매도 기준가') && !sheetText.includes('감시가격'), `sheet copy (${tag})`);
        const scroll = await id('pending-edit-scroll').boundingBox();
        inside(scroll, { x: 0, y: 0, width, height }, 'sheet body inside the viewport');
        await id('pending-edit-quantity-ratio-100').scrollIntoViewIfNeeded();
        await page.waitForTimeout(100);
        inside(await id('pending-edit-quantity-ratio-100').boundingBox(), await id('pending-edit-scroll').boundingBox(), '100% reachable');
        await shot('sheet');
        await id('pending-edit-quantity-ratio-25').click();
        assert.equal(await id('pending-edit-quantity').inputValue(), '617283.561728', `25% of the holding, rounded down (${tag})`);
        await id('pending-edit-quantity-ratio-slider').fill('75');
        assert.equal(await id('pending-edit-quantity').inputValue(), '1851850.685184', `the slider (${tag})`);
        await id('pending-edit-quantity').fill('987653.7');
        await page.waitForTimeout(100);
        assert.equal(await id('pending-edit-quantity').inputValue(), '987653.7', `typed text kept (${tag})`);
        assert.equal((await id('pending-edit-quantity-ratio-percent').innerText()).trim(), '40%', `thumb follows the typed quantity (${tag})`);
        await shot('sheet-typed');
        await id('pending-edit-review').scrollIntoViewIfNeeded();
        await page.waitForTimeout(100);
        inside(await id('pending-edit-review').boundingBox(), await id('pending-edit-scroll').boundingBox(), 'review reachable');
        await id('pending-edit-review').click();
        await id('pending-edit-changes').waitFor();
        assert.ok((await id('pending-edit-changes').innerText()).includes('987653.7'), `review (${tag})`);
        await id('pending-edit-save').scrollIntoViewIfNeeded();
        await page.waitForTimeout(100);
        inside(await id('pending-edit-save').boundingBox(), await id('pending-edit-scroll').boundingBox(), 'save reachable');
        await shot('review');
        assert.deepEqual(errors, [], `${tag} page errors`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failing = report.filter((entry) => entry.issues.length);
  assert.deepEqual(failing, [], 'clipped text or sideways scroll');
  console.log(`spot stop-loss card and 설정 변경 sheet: ${report.length} screens checked, screenshots in ${out}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
