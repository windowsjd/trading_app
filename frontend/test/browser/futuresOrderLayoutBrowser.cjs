// Futures order layout (RN Web, real FuturesScreen): the form left of the
// contract book at every phone width, font scale and theme; the USD amount,
// ratio, leverage and margin-mode sheets; the ladder's scroll/collapse; and
// the submit button's ink after a refused (409) order. Transport, account
// selection and navigation are fixtures (futuresMocks.js); `?viewport=1` gives
// a device-sized root so sheets anchor to the visible bottom like the app.
// Run: NODE_PATH=<playwright+esbuild> BROWSER_EXECUTABLE_PATH=<chromium> node test/browser/futuresOrderLayoutBrowser.cjs
// FUTURES_LAYOUT_QUICK=1 checks 320 and 430 only.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.FUTURES_LAYOUT_OUTPUT ?? path.join(require('node:os').tmpdir(), 'futures-order-layout-browser');

/** Words cut by a clipping ancestor or the viewport (scroll containers may hold more). */
function clipped() {
  const hidden = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const s = getComputedStyle(n); if (n.getAttribute('aria-hidden') === 'true' || Number(s.opacity) === 0 || s.visibility === 'hidden' || s.display === 'none') return true; } return false; };
  const problems = [];
  for (const el of document.querySelectorAll('body *')) {
    const texts = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!texts.length || hidden(el)) continue;
    for (const node of texts) for (const match of node.textContent.matchAll(/\S+/gu)) {
      const range = document.createRange(); range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      // A Latin word broken across lines ("(Lon" / "g)") reads as two words.
      // (Huge numbers may wrap at their separators by design.)
      const lines = new Set([...range.getClientRects()].filter((r) => r.width).map((r) => Math.round(r.top)));
      if (lines.size > 1 && /[A-Za-z]{2}/u.test(match[0]) && !/[가-힣]/u.test(match[0])) problems.push({ text: match[0], reason: 'split', at: el.closest('[data-testid]')?.dataset.testid ?? el.tagName });
      for (const r of range.getClientRects()) {
        if (!r.width) continue;
        // Per axis, the first scroll container can bring the word into view: stop there.
        let xScroll = false, yScroll = false;
        const where = (a) => a.closest('[data-testid]')?.dataset.testid ?? a.tagName;
        for (let a = el; a && a !== document.body && !(xScroll && yScroll); a = a.parentElement) {
          const s = getComputedStyle(a), b = a.getBoundingClientRect();
          if (!xScroll) {
            if (['auto', 'scroll'].includes(s.overflowX)) xScroll = true;
            else if (['hidden', 'clip'].includes(s.overflowX) && (r.left < b.left - 1 || r.right > b.right + 1)) problems.push({ text: match[0], reason: 'x-clip', at: where(a) });
          }
          if (!yScroll) {
            if (['auto', 'scroll'].includes(s.overflowY)) yScroll = true;
            else if (['hidden', 'clip'].includes(s.overflowY) && (r.top < b.top - 1 || r.bottom > b.bottom + 1)) problems.push({ text: match[0], reason: 'y-clip', at: where(a) });
          }
        }
        if (!xScroll && (r.left < -1 || r.right > innerWidth + 1)) problems.push({ text: match[0], reason: 'viewport', at: where(el) });
      }
    }
  }
  return problems.slice(0, 10);
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'futuresFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')], resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'], define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
    b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: path.join(__dirname, 'futuresMocks.js') }));
    b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|useFuturesOrderBook)$/ }, () => ({ path: path.join(__dirname, 'futuresMocks.js') }));
  } }], logLevel: 'warning' });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  const server = http.createServer((req, res) => { const file = req.url.startsWith('/bundle.js') ? 'bundle.js' : 'index.html'; res.setHeader('Content-Type', file === 'bundle.js' ? 'text/javascript' : 'text/html'); res.end(fs.readFileSync(path.join(out, file))); }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] }).catch((error) => { server.close(); throw error; });
  const page = await browser.newPage(); const errors = [], results = [];
  // This check is about layout: a monotonic Date keeps the fixtures' 1s-old
  // evidence fresh when the host wall clock steps backwards (WSL steps ~2s
  // every ~30s, which briefly fails freshness closed and disables the submit).
  if (process.env.FUTURES_LAYOUT_WALL_CLOCK !== '1') await page.addInitScript(() => {
    const RealDate = Date, base = RealDate.now(), start = performance.now();
    const now = () => Math.round(base + (performance.now() - start));
    class MonotonicDate extends RealDate { constructor(...args) { if (args.length) super(...args); else super(now()); } static now() { return now(); } }
    window.Date = MonotonicDate;
  });
  page.on('pageerror', (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  const id = (testId) => page.getByTestId(testId);
  const box = (testId) => id(testId).first().boundingBox();
  const open = async (query, theme) => {
    await page.goto(`${base}/?viewport=1&${query}`); await id('futures-trade').waitFor();
    await page.evaluate((value) => window.futuresAppearance.setPreference(value), theme);
    await page.waitForFunction((value) => window.futuresAppearance.mode === value, theme);
    await page.waitForTimeout(80);
  };
  // The element itself (or its content) receives a tap at its centre.
  const hittable = async (testId) => {
    await id(testId).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    // Let any smooth scroll still running settle before the hit test.
    await page.waitForTimeout(120);
    const result = await id(testId).first().evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { ok: !!hit && (el === hit || el.contains(hit)), disabled: el.getAttribute('aria-disabled'), hit: hit?.closest('[data-testid]')?.dataset.testid ?? hit?.tagName, at: new Date().toISOString() }; });
    if (!result.ok) console.error('not hittable', testId, JSON.stringify(result));
    return result.ok;
  };
  const sheetSettled = (testId) => page.waitForFunction((tid) => { const el = document.querySelector(`[data-testid="${tid}"]`); return !el; }, testId);
  try {
    const widths = process.env.FUTURES_LAYOUT_QUICK ? [320, 430] : [320, 360, 390, 430];
    for (const width of widths) for (const fontScale of [1, 1.5, 2]) for (const theme of ['light', 'dark']) for (const kind of ['open', 'isolated']) {
      const label = `${width}-${fontScale}-${theme}-${kind}`;
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 }); await page.emulateMedia({ colorScheme: theme });
      await open(`kind=${kind}&fontScale=${fontScale}&account=${theme === 'dark' ? 'B' : 'A'}`, theme);
      // Side by side: the form's right edge at or before the book's left edge, overlapping vertically.
      const form = await box('futures-trade'), book = await box('futures-price-column');
      assert.ok(form && book && form.width > 80 && book.width > 60, `${label}: both columns laid out`);
      assert.ok(form.x + form.width <= book.x + 1 && form.y < book.y + book.height && book.y < form.y + form.height, `${label}: form left of the book`);
      assert.ok(book.x + book.width <= width + 1, `${label}: the book stays on screen`);
      for (const full of ['futures-wallet', 'futures-lists']) { const b = await box(full); assert.ok(b && b.width > width - 40, `${label}: ${full} full width`); }
      assert.deepEqual(await page.evaluate(clipped), [], `${label}: clipped text`);
      if (kind === 'open') {
        for (const target of ['futures-amount', 'futures-ratio-25', 'futures-leverage-select', 'futures-margin-info']) assert.ok(await hittable(target), `${label}: ${target} tappable`);
        assert.equal(await id('futures-available-collateral').textContent(), '주문가능 9,995 USD');
        await id('futures-ratio-25').click();
        assert.notEqual(await id('futures-amount').inputValue(), '', `${label}: 25% writes an amount`);
        // Enabled by the amount, the submit takes the tap.
        assert.ok(await hittable('futures-submit'), `${label}: futures-submit tappable`);
        await id('futures-ratio-100').click();
        assert.equal(await id('futures-collateral-insufficient').count(), 0, `${label}: 100% fits the collateral`);
        assert.equal(await id('futures-amount-ratio').textContent(), '100%');
        assert.deepEqual(await page.evaluate(clipped), [], `${label}: clipped text with an amount`);
        // Leverage: a preset, then 직접 설정하기.
        // Sheets rise for 280ms: measure the settled sheet, not the motion.
        await id('futures-leverage-select').click(); await id('futures-leverage-option-10').waitFor(); await page.waitForTimeout(350);
        assert.ok(await hittable('futures-leverage-option-100') && await hittable('futures-leverage-custom'), `${label}: leverage rows reachable`);
        assert.deepEqual(await page.evaluate(clipped), [], `${label}: leverage sheet text`);
        if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `${label}-leverage-sheet.png`) });
        await id('futures-leverage-option-10').click(); await sheetSettled('futures-leverage-sheet');
        assert.equal(await id('futures-leverage-value').textContent(), '10x');
        assert.equal(await id('futures-amount-ratio').textContent(), '10%', `${label}: 10x recomputes the ratio`);
        await id('futures-leverage-select').click(); await id('futures-leverage-custom').click(); await id('futures-leverage-input').waitFor();
        await sheetSettled('futures-leverage-sheet'); await page.waitForTimeout(350);
        assert.equal(await id('futures-leverage-input').inputValue(), '10');
        await id('futures-leverage-input').fill('101'); await id('futures-leverage-error').waitFor();
        await id('futures-leverage-input').fill('37');
        assert.ok(await hittable('futures-leverage-apply'), `${label}: 설정하기 reachable`);
        assert.deepEqual(await page.evaluate(clipped), [], `${label}: custom sheet text`);
        if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `${label}-leverage-custom.png`) });
        await id('futures-leverage-apply').click(); await sheetSettled('futures-leverage-custom-sheet');
        assert.equal(await id('futures-leverage-value').textContent(), '37x');
        // 증거금 모드 ⓘ: explanation only in its sheet.
        assert.equal(await page.getByText(/공동 담보를 교차 포지션들이 함께/).count(), 0);
        await id('futures-margin-info').click(); await id('futures-margin-info-body').waitFor(); await page.waitForTimeout(350);
        assert.deepEqual(await page.evaluate(clipped), [], `${label}: help sheet text`);
        if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `${label}-margin-help.png`) });
        await id('futures-margin-info-sheet-close').click(); await sheetSettled('futures-margin-info-sheet');
        // The ladder keeps its horizontal scroll and collapse.
        const ladder = await page.evaluate(() => { const el = document.querySelector('[data-testid="asset-order-book-asks-scroll"]'); if (!el) return null; const scroller = [el, ...el.querySelectorAll('div')].find((n) => n.scrollWidth > n.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(n).overflowX)); if (!scroller) return { overflow: false }; scroller.scrollLeft = 40; return { overflow: true, scrolled: scroller.scrollLeft > 0 }; });
        assert.ok(ladder, `${label}: ladder rendered`);
        if (ladder.overflow) assert.equal(ladder.scrolled, true, `${label}: wide ladder scrolls sideways`);
        await id('futures-order-book-toggle').click(); await page.waitForFunction(() => !document.querySelector('[data-testid="asset-order-book"]'));
        const collapsedForm = await box('futures-trade'), collapsedBook = await box('futures-price-column');
        assert.ok(collapsedForm.x + collapsedForm.width <= collapsedBook.x + 1, `${label}: collapsed book keeps its column`);
        await id('futures-order-book-toggle').click(); await id('asset-order-book').waitFor();
      } else {
        // A position card action selects the trade form and scrolls it into view.
        await id('futures-position-A:position-reduce').or(id('futures-position-B:position-reduce')).first().scrollIntoViewIfNeeded();
        // The screen learns its offset from scroll events; a finger cannot tap within the jump's frame.
        await page.waitForTimeout(150);
        await id('futures-position-A:position-reduce').or(id('futures-position-B:position-reduce')).first().click();
        // A long smooth scroll takes about a second on the web.
        await page.waitForFunction(() => { const sc = document.querySelector('[data-testid="futures-screen"]'); const last = window.__lastTop; window.__lastTop = sc.scrollTop; return last === sc.scrollTop; }, null, { polling: 150, timeout: 5000 });
        const { top, height } = await page.evaluate(() => ({ top: document.querySelector('[data-testid="futures-trading-columns"]').getBoundingClientRect().top, height: innerHeight }));
        // The form lands 12pt under the screen top.
        assert.ok(Math.abs(top - 12) <= 2, `${label}: the form scrolled into view (${top})`);
        assert.ok(top < height / 2);
        assert.equal(await id('futures-amount').getAttribute('aria-label'), '감소 금액 (USD)');
        await id('futures-ratio-50').click();
        assert.equal(await id('futures-amount').inputValue(), '102', `${label}: 50% of the 2 BTC position at 102`);
        assert.ok(await hittable('futures-submit'), `${label}: submit tappable`);
        assert.deepEqual(await page.evaluate(clipped), [], `${label}: reduce form text`);
        await id('futures-ratio-100').click(); await id('futures-close-summary').waitFor();
        assert.match(await id('futures-submit').textContent(), /전량 종료/);
      }
      if (fontScale !== 1.5 && (width === 320 || width === 430)) {
        await page.evaluate(() => document.querySelector('[data-testid="futures-screen"]').scrollTo(0, 0));
        await id('futures-trading-columns').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, `${label}.png`) });
      }
      results.push(label);
    }
    // A short keyboard-sized viewport: the amount and the submit stay reachable.
    await page.setViewportSize({ width: 320, height: 300 });
    await open('kind=open&fontScale=1.5', 'light');
    await id('futures-amount').fill('51'); await id('futures-amount').focus();
    assert.ok(await hittable('futures-amount') && await hittable('futures-submit'), 'keyboard-sized viewport');
    // The order button after a refused (409) order: no frozen ink, usable again, reason under it.
    await page.setViewportSize({ width: 390, height: 844 });
    const ink = [];
    for (const [query, label] of [['execute=409&executeDelay=60', '409'], ['execute=409&executeDelay=0', '409-immediate']]) {
      await open(`kind=open&${query}`, 'light');
      await id('futures-amount').fill('51');
      const b = await box('futures-submit');
      await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
      await id('futures-order-notice').waitFor();
      assert.equal(await id('futures-order-notice').textContent(), '사용 가능한 담보가 부족합니다. 주문 금액이나 레버리지를 조정해주세요.');
      const order = await page.evaluate(() => { const submit = document.querySelector('[data-testid="futures-submit"]'), notice = document.querySelector('[data-testid="futures-order-notice"]'); return submit.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before'; });
      assert.equal(order, 'after', 'the reason reads under the button');
      await page.waitForTimeout(500);
      const state = await page.evaluate(() => {
        const submit = document.querySelector('[data-testid="futures-submit"]');
        const inkEl = [...submit.querySelectorAll('div')].find((n) => { const s = getComputedStyle(n); return s.position === 'absolute' && s.width === '64px' && s.height === '64px' && s.borderRadius === '32px'; });
        return { disabled: submit.getAttribute('aria-disabled'), busy: submit.getAttribute('aria-busy'), inkOpacity: inkEl ? Number(getComputedStyle(inkEl).opacity) : null };
      });
      ink.push({ label, ...state });
      assert.equal(state.inkOpacity, 0, `${label}: the ink faded out (${JSON.stringify(state)})`);
      assert.notEqual(state.disabled, 'true', `${label}: the button is enabled again`);
      assert.equal(await id('futures-retry').count(), 0, `${label}: a refusal is not an unknown result`);
      await page.screenshot({ path: path.join(out, `390-${label}-after.png`) });
    }
    // A lost response asks for the same-request check instead.
    await open('kind=open&execute=network', 'light');
    await id('futures-amount').fill('51'); await id('futures-submit').click(); await id('futures-retry').waitFor();
    assert.match(await id('futures-order-notice').textContent(), /체결을 확인하지 못했습니다/);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ layouts: results.length, results, ink, errors, scope: 'RN Web; native Android/iOS rendering, IME and haptics not exercised' }, null, 2));
    console.log(`Futures order layout browser: ${results.length} layouts, sheets, ladder, keyboard-size and 409 ink checks passed`);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
