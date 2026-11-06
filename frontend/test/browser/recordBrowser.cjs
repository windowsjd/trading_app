// RN Web glyph bounds, colors and chart interaction. Actual native navigation
// is covered separately by walletBrowser's production RootNavigator fixture.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.RECORD_BROWSER_OUTPUT ?? '/tmp/trading-record-browser';
// [rise, fall] direction text of src/theme/financialColors.ts FINANCIAL_PALETTES
// (re-tuned 2026-10-12; this copy was the older palette until 2026-11-06).
const palette = { light: { red_blue: ['rgb(200, 36, 30)', 'rgb(27, 94, 201)'], green_red: ['rgb(17, 128, 56)', 'rgb(200, 36, 30)'] }, dark: { red_blue: ['rgb(255, 107, 100)', 'rgb(100, 162, 255)'], green_red: ['rgb(78, 212, 114)', 'rgb(255, 107, 100)'] } };
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'recordFixture.jsx')], outfile: path.join(out, 'record.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')], resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'], define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, plugins: [{ name: 'record-fixtures', setup(b) {
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
    b.onResolve({ filter: /services\/api\/client$/ }, () => ({ path: path.join(__dirname, 'recordMocks.js') }));
  } }], logLevel: 'warning' });
  const server = http.createServer((req, res) => { const script = req.url.startsWith('/record.js'); res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html'); res.end(script ? fs.readFileSync(path.join(out, 'record.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/record.js"></script>'); }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(), errors = [], records = [], base = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => { const p = new URLSearchParams(location.search); localStorage.setItem('selectedTradingAccountId:home-user', 'general-account'); localStorage.setItem('trading-app:appearance', 'system'); localStorage.setItem('trading-app:financial-colors', p.get('palette') ?? 'red_blue'); });
  const id = value => page.getByTestId(value), color = locator => locator.evaluate(el => getComputedStyle(el).color);
  const clippedText = () => page.evaluate(() => {
    const viewport = innerWidth, clipped = [], walker = document.createTreeWalker(document.getElementById('root'), NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!node.textContent.trim() || parent.closest('svg') || getComputedStyle(parent).visibility === 'hidden') continue;
      const box = parent.getBoundingClientRect();
      for (let i = 0; i < node.textContent.length; i++) {
        if (/\s/.test(node.textContent[i])) continue;
        const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
        for (const rect of range.getClientRects()) if (rect.width && (rect.left < -1 || rect.right > viewport + 1 || rect.left < box.left - 1 || rect.right > box.right + 1)) { clipped.push({ text: node.textContent, glyph: node.textContent[i], left: rect.left, right: rect.right, box: [box.left, box.right] }); break; }
      }
    }
    return clipped;
  });
  // 거래내역 > 선물 (2026-11-06): 포지션 진입 / 포지션 종료, each one paged server
  // union with its own paging, under the same account; 현물 brings the orders back.
  const futuresHistoryChecks = async (tag, shot) => {
    await id('trade-history-futures').click();
    await id('trade-history-futures-screen').waitFor();
    await page.getByText(/신규 진입\(Open\) · 롱\(Long\)/).waitFor();
    assert.equal(await id('record-order-item-order-1').count(), 0, `${tag}: no spot orders under 선물`);
    let text = await id('trade-history-futures-screen').innerText();
    assert.match(text, /수량 \/ 체결가 · 선물 Last/); assert.match(text, /수량 \/ 체결가 · Spot\(이전 기준\)/);
    assert.match(text, /수량 추가\(Increase\) · 숏\(Short\)/);
    assert.doesNotMatch(text, /실제|전량 종료|수량 감소|강제청산|시즌 종료 정산|체결 기록/);
    assert.deepEqual(await clippedText(), [], `${tag} entries`);
    if (shot) await page.screenshot({ path: path.join(out, `futures-entries-${shot}.png`), fullPage: true });
    await page.getByRole('button', { name: '다음', exact: true }).click();
    await page.getByText(/SOLUSDT · 수량 추가\(Increase\)/).waitFor();
    assert.equal(await page.getByText(/신규 진입\(Open\)/).count(), 0, `${tag}: page 2 replaces page 1`);
    await page.getByRole('button', { name: '이전', exact: true }).click();
    await page.getByText(/신규 진입\(Open\) · 롱\(Long\)/).waitFor();
    await id('futures-history-exits').click();
    await page.getByText('Mark 청산가', { exact: true }).first().waitFor();
    text = await id('trade-history-futures-screen').innerText();
    // The Season exit, a user close and one liquidation event, in the server's order.
    assert.match(text, /시즌 종료 정산 · 1개 포지션[\s\S]*전량 종료\(Close\) · 숏\(Short\)[\s\S]*교차\(Cross\) 전량 강제청산 · 2개 포지션/);
    assert.match(text, /시즌 종료 가격 · 선물 Last/);
    assert.match(text, /정산 수수료/); assert.match(text, /현금 정산/); assert.doesNotMatch(text, /실제|신규 진입|강제청산 기록/);
    assert.deepEqual(await clippedText(), [], `${tag} exits`);
    // The segment's selection slides (spring); capture it settled.
    if (shot) { await page.waitForTimeout(450); await page.screenshot({ path: path.join(out, `futures-exits-${shot}.png`), fullPage: true }); }
    await id('trade-history-spot').click();
    await id('record-order-item-order-1').waitFor();
  };
  // 지갑 원장 (2026-10-16): the header names the account without its status; each
  // figure shares the line of what it belongs to (amount | title, balance | asset)
  // and, when the line is too narrow, wraps under it right-aligned instead of clipping.
  const ledgerChecks = async (tag, sameRow) => {
    const header = await id('wallet-transactions-account').innerText();
    assert.ok(header.trim() && !/운영 중/.test(header), `${tag}: ledger header ${header}`);
    const lines = await page.evaluate(() => [...document.querySelectorAll('[data-testid$="-amount-line"], [data-testid$="-balance-line"]')].map((line) => {
      // Glyph runs (\S+) only: RN-Web text is pre-wrap, so a trailing space can hang past the edge.
      const glyphs = (el) => {
        const rects = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) for (const match of walker.currentNode.textContent.matchAll(/\S+/gu)) {
          const range = document.createRange(); range.setStart(walker.currentNode, match.index); range.setEnd(walker.currentNode, match.index + match[0].length);
          rects.push(...[...range.getClientRects()].filter((r) => r.width));
        }
        return [Math.min(...rects.map((r) => r.left)), Math.min(...rects.map((r) => r.top)), Math.max(...rects.map((r) => r.right)), Math.max(...rects.map((r) => r.bottom)), new Set(rects.map((r) => Math.round(r.top))).size];
      };
      const [start, end] = [...line.children], box = line.getBoundingClientRect(), card = line.parentElement.getBoundingClientRect();
      return { line: line.dataset.testid, right: box.right, start: glyphs(start), end: glyphs(end), card: [card.left, card.right] };
    }));
    assert.equal(lines.length, 6, `${tag}: two lines in each of the three rows`);
    for (const { line, right, start: [sl, st, sr, sb, startLines], end: [el, et, er, eb], card } of lines) {
      // A short title (환전, 광고 보상, 매수 …) is never squeezed into a mid-word break.
      if (line.endsWith('-amount-line')) assert.equal(startLines, 1, `${tag}: ${line} title on one line`);
      const together = Math.min(sb, eb) - Math.max(st, et) > 0;
      if (sameRow) assert.ok(together, `${tag}: ${line} figure on the same row`);
      if (together) assert.ok(sr <= el + 1, `${tag}: ${line} text and figure overlap`);
      else assert.ok(et >= sb - 1, `${tag}: ${line} wrapped figure under the text`);
      assert.ok(Math.abs(er - right) <= 1.5, `${tag}: ${line} figure right-aligned (${er} vs ${right})`);
      assert.ok(sl >= card[0] - 1 && er <= card[1] + 1, `${tag}: ${line} inside the card`);
    }
  };
  try {
    for (const width of [320, 360, 390, 430]) for (const appearance of ['light', 'dark']) for (const preference of ['red_blue', 'green_red']) for (const fontScale of [1, 1.5, 2]) for (const long of [0, 1]) for (const screen of (process.env.RECORD_BROWSER_SCREENS?.split(',') ?? ['detail', 'profit', 'history', 'futures', 'ledger'])) {
      await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?record=${screen === 'futures' ? 'history' : screen}&navigation=1&palette=${preference}&fontScale=${fontScale}&long=${long}`);
      await id(screen === 'detail' ? 'record-detail-return' : screen === 'profit' ? 'record-profit-total' : screen === 'ledger' ? 'wallet-transaction-item-wtx-buy' : 'record-order-item-order-1').waitFor();
      const tag = JSON.stringify({ width, appearance, preference, fontScale, long, screen });
      if (screen === 'history') {
        // 2026-10-16: 현물 | 선물 above the orders; amounts without the 실제 prefix.
        await id('trade-history-market').waitFor();
        // A BUY ends with 총액 = what it paid, fee included (2026-11-06; 총액·차감액 before).
        const buyRow = await id('record-order-item-order-1').innerText();
        assert.match(buyRow, /체결가[\s\S]*수수료[\s\S]*총액/);
        assert.doesNotMatch(buyRow, /차감액|총액[\s\S]*수수료|실현손익/);
        assert.doesNotMatch(await page.locator('body').innerText(), /실제/);
        // A SELL ends with its stored 실현손익 (2026-11-06; 총액·수령액 before): signed
        // and colored, an exact 0 neutral, a sell without the figure 확인 불가 (never 0).
        const sellRows = await Promise.all([2, 3, 4].map(i => id(`record-order-item-order-${i}`).innerText()));
        for (const row of sellRows) assert.doesNotMatch(row, /총액|수령액/, `${tag}: a SELL has no 총액·수령액`);
        assert.match(sellRows[0], long ? /수수료[\s\S]*실현손익\s+-1,234,567,890,123,456원/ : /수수료[\s\S]*실현손익\s+\+12,346원/);
        assert.equal(await color(id('record-order-realized-pnl-order-2')), palette[appearance][preference][long ? 1 : 0]);
        assert.match(sellRows[1], /수수료[\s\S]*실현손익\s+0원/);
        assert.ok(!palette[appearance][preference].includes(await color(id('record-order-realized-pnl-order-3'))), `${tag}: 0 is neutral`);
        assert.match(sellRows[2], /수수료[\s\S]*실현손익\s+확인 불가[\s\S]*주문별 손익 기록 전 거래예요/);
        assert.doesNotMatch(sellRows[2], /0원/);
      }
      if (screen === 'futures') await futuresHistoryChecks(tag, width === 320 && fontScale === 2 && preference === 'red_blue' ? `${appearance}-${long ? 'long' : 'normal'}` : null);
      if (screen === 'ledger') await ledgerChecks(tag, fontScale === 1 && !long);
      if (screen === 'ledger' && width === 320 && fontScale === 2 && preference === 'red_blue') await page.screenshot({ path: path.join(out, `ledger-2x-${appearance}-${long ? 'long' : 'normal'}.png`), fullPage: true });
      if (screen === 'detail' || screen === 'profit') {
        const history = id(screen === 'detail' ? 'record-season-detail-orders-cta' : 'record-profit-orders-cta');
        assert.equal(await history.evaluate(el => getComputedStyle(el).backgroundColor), appearance === 'light' ? 'rgb(234, 244, 252)' : 'rgb(28, 48, 66)');
        assert.equal(await color(history.locator('[dir="auto"]')), appearance === 'light' ? 'rgb(40, 91, 133)' : 'rgb(185, 221, 252)');
        assert.equal(await history.locator('linearGradient').count(), 0);
        if (screen === 'detail') {
          const stops = await id('record-season-detail-profit-analysis-cta').locator('linearGradient stop').evaluateAll(nodes => nodes.map(node => node.getAttribute('stop-color')));
          assert.deepEqual(stops, ['#326FE5', '#4C32E5']);
        }
        const positive = screen === 'detail' ? ['record-detail-return', 'record-detail-pnl'] : ['record-profit-total', 'record-profit-return', 'record-profit-realized', 'record-profit-best-pnl', 'record-profit-best-return'];
        for (const metric of positive) assert.equal(await color(id(metric)), palette[appearance][preference][0], metric);
        if (screen === 'profit') for (const metric of ['record-profit-unrealized', 'record-profit-worst-pnl', 'record-profit-worst-return']) assert.equal(await color(id(metric)), palette[appearance][preference][1], metric);
        assert.equal(await id(screen === 'detail' ? 'record-detail-pnl' : 'record-profit-total').textContent(), long ? '+1,234,567,890,123,456원' : '+777,777원');
        if (screen === 'detail') {
          assert.equal(await id('record-detail-rank').textContent(), '#100000');
          assert.ok(!palette[appearance][preference].includes(await color(id('record-detail-assets'))));
        }
        const text = await page.locator('body').textContent();
        assert.doesNotMatch(text, /MDD|private timestamp|private snapshot|RAW_|domestic_stock|partial_unavailable|총 주문|환전 내역/);
      }
      // The 선물 pass measured its own views above; the spot list it returns to is the 'history' screen's.
      const clipping = screen === 'futures' ? [] : await clippedText();
      assert.deepEqual(clipping, [], JSON.stringify({ width, appearance, preference, fontScale, long, screen, clipping: clipping.slice(0, 5) }));
      if (screen === 'profit' && fontScale === 1) {
        const plot = page.locator('[role="img"][aria-label^="차트."] svg');
        await plot.scrollIntoViewIfNeeded();
        const box = await plot.boundingBox();
        await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
        await page.mouse.down();
        await id('line-chart-tooltip').waitFor();
        assert.match(await id('line-chart-tooltip').textContent(), /2026-09-30.*11,234,000원/);
        await page.mouse.up();
        await id('line-chart-tooltip').waitFor({ state: 'hidden' });
      }
      if (width === 320 && long && fontScale === 1 && preference === 'red_blue') await page.screenshot({ path: path.join(out, `${screen}-${appearance}.png`), fullPage: true });
      records.push({ width, appearance, preference, fontScale, long, screen });
    }
    for (const state of ['unavailable', 'partial_unavailable']) {
      await page.goto(`${base}/?record=profit&navigation=1&recordState=${state}`); await id('record-profit-total').waitFor();
      assert.equal(await id('record-profit-total').textContent(), '-');
      assert.equal(await id('record-profit-unrealized').textContent(), '-');
      assert.equal(await id('record-profit-realized').textContent(), state === 'unavailable' ? '-' : '+900,000원');
      assert.doesNotMatch(await page.locator('body').textContent(), /RAW_|domestic_stock/);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ pass: true, records, states: ['unavailable', 'partial_unavailable'], errors }, null, 2));
    console.log(`RECORD_BROWSER_PASSED ${records.length} layouts, semantic palettes, large values, full names, chart tooltip and unavailable states`);
  } finally { await browser.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exit(1); });
