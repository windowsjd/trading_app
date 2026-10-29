// RN Web check of a futures position card and its sheets (2026-10-28): the card
// shows the L box, 예상 종료 수수료 where 보유 수량 was, no 포지션 증가/감소, no 누적
// 실현 손익, and 손절가/익절가 설정 | 포지션 종료 side by side (stacked when the
// screen is narrow for its font); 포지션 종료 opens its sheet (position, 시장가,
// 100% amount, 포지션 규모 / 예상 손익 / 예상 수수료, confirm) on screen with its
// confirm reachable; 손절가/익절가 shows the same position block. No text is cut
// and nothing scrolls sideways, at 320/360/390/430 × light/dark × font 1/2.
// RN Web only — not a device check. Requires esbuild and Playwright (see README);
// FUTURES_CLOSE_QUICK=1 checks 320 dark 2x and 390 light 1x only.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.FUTURES_CLOSE_BROWSER_OUTPUT ?? '/tmp/trading-futures-close-sheet';

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
    for (const [width, appearance, fontScale] of process.env.FUTURES_CLOSE_QUICK === '1' ? [[320, 'dark', 2], [390, 'light', 1]] : combos) {
      const height = fontScale === 2 ? 640 : 760;
      const page = await browser.newPage({ viewport: { width, height } });
      await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
      await page.emulateMedia({ colorScheme: appearance });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
      const tag = `${width}-${appearance}-${fontScale}x`;
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
      const card = 'futures-position-account-fixture:position';

      await page.goto(`${base}/?screen=futures&viewport=1&fontScale=${fontScale}&futuresPosition=1`);
      await id(card).waitFor();
      await id(`${card}-close`).scrollIntoViewIfNeeded();
      // The card: L box, the fee where 보유 수량 was, two actions only.
      const cardText = await id(card).innerText();
      for (const gone of ['보유 수량', '격리 담보', '유지 증거금 + 종료 수수료', '누적 실현 손익', '포지션 증가', '포지션 감소', '전량 종료', 'LONG'])
        assert.equal(cardText.includes(gone), false, `${gone} is gone (${tag})`);
      assert.equal(cardText.includes('예상 종료 수수료'), true, `fee shown (${tag})`);
      const badge = await id(`${card}-direction`).boundingBox();
      assert.equal((await id(`${card}-direction`).innerText()).trim(), 'L', `the L box (${tag})`);
      assert.equal(await id(`${card}-direction`).getAttribute('aria-label'), '롱(Long)', `spoken side (${tag})`);
      assert.ok(badge.width >= 18 && badge.height >= 18, `box size ${badge.width}x${badge.height} (${tag})`);
      const tpSl = await id(`${card}-protection`).boundingBox(), close = await id(`${card}-close`).boundingBox();
      if (width / fontScale >= 300) {
        assert.ok(Math.abs(tpSl.y - close.y) <= 1 && Math.abs(tpSl.width - close.width) <= 2 && tpSl.x < close.x, `side by side (${tag})`);
      } else {
        assert.ok(close.y >= tpSl.y + tpSl.height - 1, `stacked on a narrow screen (${tag})`);
      }
      for (const button of [`${card}-protection`, `${card}-close`]) assert.deepEqual(await labelInside(page, button), [], tag);
      await shot('card');

      // 포지션 종료 → its sheet, at 100%.
      await id(`${card}-close`).click();
      await id('futures-close-submit').waitFor();
      await page.waitForTimeout(450);
      assert.equal((await id('futures-close-submit').innerText()).trim(), '포지션 종료', tag);
      assert.equal(await id('futures-close-amount').inputValue(), '204', `100% at Futures Last 102 (${tag})`);
      const sheetText = await id('futures-close-sheet').innerText();
      for (const part of ['포지션 종료', '종목', '진입가 (USD)', 'Mark Price (USD)', '가격', '시장가', '종료 금액 (USD)', '포지션 규모', '예상 손익', '예상 수수료'])
        assert.equal(sheetText.includes(part), true, `${part} (${tag})`);
      assert.equal(/Confirm|Market Price|Estimated|Entry Price/u.test(sheetText), false, `Korean only (${tag})`);
      const scroll = await id('futures-close-scroll').boundingBox();
      inside(scroll, { x: 0, y: 0, width, height }, 'sheet body inside the viewport');
      await id('futures-close-submit').scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      inside(await id('futures-close-submit').boundingBox(), await id('futures-close-scroll').boundingBox(), 'confirm reachable');
      assert.deepEqual(await labelInside(page, 'futures-close-submit'), [], tag);
      await shot('close-sheet');
      await id('futures-close-amount-ratio-50').scrollIntoViewIfNeeded();
      await id('futures-close-amount-ratio-50').click();
      assert.equal(await id('futures-close-amount').inputValue(), '102', tag);
      assert.equal((await id('futures-close-submit').innerText()).trim(), '포지션 감소', tag);
      await shot('close-sheet-50');
      await id('futures-close-sheet-close').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="futures-close-sheet"]') ?? document.body).pointerEvents === 'none'
        || !document.querySelector('[data-testid="futures-close-sheet"]'));

      // 손절가/익절가 → the same position block on top.
      await id(`${card}-protection`).click();
      await id('tp-sl-summary').waitFor();
      assert.equal((await id('tp-sl-summary-direction').innerText()).trim(), 'L', tag);
      await shot('tp-sl-sheet');
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
  console.log(`futures position card and sheets: ${report.length} screens checked, screenshots in ${out}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
