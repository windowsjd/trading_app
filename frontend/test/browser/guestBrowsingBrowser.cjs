// 「로그인 없이 둘러보기」 (2026-10-30) on RN Web: the production Login screen,
// guest tabs, headers, sheets and React Query over a read-only fixture
// transport that answers like the server's GUEST_MARKET_DATA_ASSET_TYPES.
// Usage: NODE_PATH=<browser-tools>/node_modules BROWSER_EXECUTABLE_PATH=…
//   node test/browser/guestBrowsingBrowser.cjs   (GUEST_BROWSER_QUICK=1: 320px only)
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const out = process.env.GUEST_BROWSER_OUTPUT ?? '/tmp/trading-guest-browser';
const quick = process.env.GUEST_BROWSER_QUICK === '1';
const root = path.resolve(__dirname, '../..');

// Every visible word inside the viewport and inside any overflow-hidden box.
// Skips aria-hidden and fully transparent subtrees (inactive tabs, measurers).
function overflowFindings() {
  const findings = [];
  const hidden = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (e.getAttribute('aria-hidden') === 'true' || Number(s.opacity) === 0 || s.visibility === 'hidden' || s.display === 'none') return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!node.textContent.trim() || !el || hidden(el) || el.closest('script,style')) continue;
    // An ellipsis means a cut, however few pixels (tab labels are one line).
    if (getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) findings.push({ text: node.textContent, reason: 'ellipsis' });
    for (const match of node.textContent.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      for (const r of range.getClientRects()) {
        if (!r.width) continue;
        if (r.left < -1 || r.right > innerWidth + 1) findings.push({ text: match[0], reason: 'viewport', left: Math.round(r.left), right: Math.round(r.right) });
        // Below the fold of a vertical scroll view is scrolling, not clipping.
        let scrolls = false;
        for (let p = el; p; p = p.parentElement) {
          const s = getComputedStyle(p), box = p.getBoundingClientRect();
          if (/hidden|clip/.test(s.overflowX) && (r.left < box.left - 1 || r.right > box.right + 1)) { findings.push({ text: match[0], reason: 'clipped-x' }); break; }
          if (/auto|scroll/.test(s.overflowY)) scrolls = true;
          if (scrolls) continue;
          // A glyph box runs a little past a tight single-line box (tab labels):
          // only a real cut — over a quarter of the glyph outside — counts.
          const outside = Math.max(0, box.top - r.top) + Math.max(0, r.bottom - box.bottom);
          if (/hidden|clip/.test(s.overflowY) && outside > r.height * 0.25) { findings.push({ text: match[0], reason: 'clipped-y' }); break; }
        }
      }
    }
  }
  return findings;
}

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'guestBrowsingFixture.jsx')], outfile: path.join(out, 'guest.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'guest-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'mainTabHeadersNativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook)$/ }, () => ({ path: path.join(__dirname, 'guestBrowsingMocks.js') }));
      b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'guestBrowsingBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/guest.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'guest.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/guest.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [], layouts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
  const settle = () => page.waitForTimeout(450);
  const tab = (label) => page.locator('a[role="tab"]').filter({ hasText: label });
  const check = async (context, name) => {
    await settle();
    const findings = await page.evaluate(overflowFindings);
    await page.screenshot({ path: path.join(out, `${context.id}-${name}.png`) });
    assert.deepEqual(findings, [], `${context.id} ${name}: ${JSON.stringify(findings)}`);
    layouts.push(`${context.id}-${name}`);
  };
  try {
    // Detector self-test: a clipped line and an off-screen word must be reported.
    await page.goto(`${base}/`);
    await page.getByTestId('auth-guest-browse').waitFor();
    const control = await page.evaluate((source) => {
      const detector = new Function(`return (${source})()`);
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:0;top:0;width:40px;overflow:hidden;white-space:nowrap';
      box.textContent = '로그인하면 보유 중인 종목과 포지션을 확인할 수 있습니다.';
      document.body.append(box);
      const clipped = detector().length;
      box.style.cssText = 'position:absolute;left:0;top:0;width:200px;height:12px;overflow:hidden;font-size:16px;line-height:20px';
      const cut = detector().length;
      box.style.cssText = 'position:absolute;left:0;top:0;width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      const ellipsis = detector().filter((finding) => finding.reason === 'ellipsis').length;
      box.style.cssText = 'position:absolute;left:-200px;top:0;white-space:nowrap';
      const offscreen = detector().length;
      box.remove();
      return { clipped, cut, ellipsis, offscreen, clean: detector().length };
    }, overflowFindings.toString());
    assert.ok(control.clipped > 0 && control.cut > 0 && control.ellipsis > 0 && control.offscreen > 0 && control.clean === 0, JSON.stringify(control));

    // Bottom tab labels at every common width and text size: no label is cut.
    for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${base}/?fontScale=${fontScale}`);
      await page.getByTestId('auth-guest-browse').click();
      await page.getByTestId('home-guest-hero').waitFor();
      await settle();
      const labels = await page.locator('a[role="tab"]').evaluateAll((tabs) => tabs.map((tab) => {
        const label = [...tab.querySelectorAll('div')].find((el) => el.childElementCount === 0 && el.textContent.trim());
        return { text: label.textContent, need: label.scrollWidth, room: label.clientWidth };
      }));
      assert.deepEqual(labels.map((label) => label.text), ['홈', '마켓', '가이드', '지갑', '투자모드']);
      for (const label of labels) assert.ok(label.need <= label.room, `${width}px x${fontScale}: ${JSON.stringify(label)}`);
      layouts.push(`tabs-${width}-x${fontScale}`);
    }

    for (const guestTypes of ['', 'crypto,crypto_futures']) for (const appearance of ['light', 'dark'])
      for (const width of quick ? [320] : [320, 390]) for (const fontScale of [1, 2]) {
        const id = `${guestTypes ? guestTypes.replace(',', '+') : 'none'}-${appearance}-${width}-x${fontScale}`;
        const futuresOn = guestTypes.includes('crypto_futures');
        const context = { id };
        await page.setViewportSize({ width, height: width === 320 ? 640 : 844 });
        await page.emulateMedia({ colorScheme: appearance, reducedMotion: 'no-preference' });
        await page.goto(`${base}/?fontScale=${fontScale}&guestTypes=${guestTypes}`);
        await page.getByTestId('auth-guest-browse').waitFor();
        assert.equal(await page.getByTestId('auth-guest-browse').innerText(), '로그인 없이 둘러보기');
        await check(context, 'login');
        // A secondary button: 로그인's width, at least its height, an edge and a
        // fill apart from the canvas and the fields, a readable label, no underline.
        const button = await page.evaluate(() => {
          const box = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
          const el = document.querySelector('[data-testid="auth-guest-browse"]');
          const label = [...el.querySelectorAll('div')].find((node) => node.childElementCount === 0 && node.textContent.trim());
          const surface = [el, ...el.querySelectorAll('div')].find((node) => getComputedStyle(node).borderTopWidth !== '0px') ?? el;
          const fill = [el, ...el.querySelectorAll('div')].map((node) => getComputedStyle(node).backgroundColor).find((color) => color !== 'rgba(0, 0, 0, 0)');
          const input = getComputedStyle(document.querySelector('[data-testid="auth-login-email-input"]') ?? document.querySelector('input')).backgroundColor;
          const canvas = [...document.querySelectorAll('div')].map((node) => getComputedStyle(node).backgroundColor).find((color) => color !== 'rgba(0, 0, 0, 0)');
          const rgb = (color) => color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
          const lum = (color) => rgb(color).map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
          const style = getComputedStyle(label);
          return { width: box('auth-guest-browse').width, height: box('auth-guest-browse').height, login: box('auth-login-submit'),
            border: getComputedStyle(surface).borderTopWidth, fill, input, canvas, decoration: style.textDecorationLine,
            labelContrast: ratio(style.color, fill), labelFits: label.scrollWidth <= label.clientWidth + 1 };
        });
        assert.ok(Math.abs(button.width - button.login.width) <= 1, JSON.stringify(button));
        assert.ok(button.height >= 48 && button.height >= button.login.height - 1, JSON.stringify(button));
        assert.ok(button.border !== '0px' && button.decoration === 'none' && button.labelFits, JSON.stringify(button));
        assert.ok(button.fill && button.fill !== button.canvas && button.fill !== button.input, JSON.stringify(button));
        assert.ok(button.labelContrast >= 4.5, JSON.stringify(button));

        await page.getByTestId('auth-guest-browse').click();
        await page.getByTestId('home-guest-hero').waitFor();
        assert.equal(await page.evaluate(() => window.fixture.isGuestBrowsing()), true);
        assert.deepEqual(await page.locator('a[role="tab"]').allInnerTexts(), ['홈', '마켓', '가이드', '지갑', '투자모드']);
        assert.equal(await page.getByText('비회원', { exact: false }).count(), 0, 'no guest banner');
        const hero = await page.getByTestId('home-guest-hero').innerText();
        for (const line of ['총 자산', '로그인 후 나의 자산을 확인하세요', '가상투자를 시작하고 총자산과 수익률을 관리해 보세요.', '로그인', '회원가입']) assert.ok(hero.includes(line), line);
        await page.getByTestId('home-hot-sign-in').waitFor();
        await check(context, 'home');
        await page.getByTestId('home-guest-holdings').scrollIntoViewIfNeeded();
        await check(context, 'home-holdings');
        await page.getByTestId('home-hot-tab-crypto').click();
        if (guestTypes) {
          await page.locator('[data-testid^="home-hot-item-"]').first().waitFor();
          assert.equal(await page.locator('[data-testid^="home-hot-item-"]').count() > 0, true);
        } else {
          await page.getByText('로그인하면 암호화폐 거래대금 TOP 5를 확인할 수 있습니다.').waitFor();
        }
        await page.getByTestId('home-hot').scrollIntoViewIfNeeded();
        await check(context, 'home-hot');

        await tab('마켓').click();
        await page.getByTestId('market-tab-crypto').last().click();
        if (guestTypes) {
          await page.locator('[data-testid^="market-item-"]').first().waitFor();
          await check(context, 'market-crypto');
          await page.locator('[data-testid^="market-item-"]').first().click();
          await page.getByTestId('asset-order-actions').waitFor();
          assert.equal(await page.getByRole('tab').count(), 0, 'detail hides the tab bar');
          await page.getByTestId('asset-detail-open-buy-order').click();
          await page.getByTestId('asset-sign-in').waitFor();
          await check(context, 'asset-sign-in-sheet');
          await page.getByTestId('asset-sign-in-close').click();
          await page.getByTestId('asset-sign-in').waitFor({ state: 'detached' });
          // The stack's own back (RN Web keeps no browser history here).
          await page.evaluate(() => window.fixture.navigationRef.goBack());
          await page.getByRole('tab', { name: '마켓' }).waitFor();
        } else {
          await page.getByTestId('market-sign-in').waitFor();
          await check(context, 'market-sign-in');
        }
        await page.getByTestId('crypto-product-futures').last().click();
        if (futuresOn) {
          // The contracts' market data: list → detail (Last, won, chart) → sign-in sheet.
          await page.getByTestId('futures-market-btc').waitFor();
          await check(context, 'market-futures');
          await page.getByTestId('futures-market-btc').click();
          await page.getByTestId('futures-detail-screen').waitFor();
          assert.equal(await page.getByTestId('futures-detail-primary-price').innerText(), '$102');
          assert.equal(await page.getByTestId('futures-detail-unbound').count(), 0);
          await check(context, 'futures-detail');
          await page.getByTestId('futures-detail-long').click();
          await page.getByTestId('futures-sign-in').waitFor();
          await check(context, 'futures-sign-in-sheet');
          await page.getByTestId('futures-sign-in-close').click();
          await page.getByTestId('futures-sign-in').waitFor({ state: 'detached' });
          await page.evaluate(() => window.fixture.navigationRef.goBack());
          await page.getByRole('tab', { name: '마켓' }).waitFor();
        } else {
          await page.getByTestId('market-futures-sign-in').waitFor();
          await check(context, 'market-futures');
        }

        await tab('가이드').click();
        await page.getByRole('heading', { name: '가이드' }).last().waitFor();
        await check(context, 'guide');

        await tab('지갑').click();
        await page.getByTestId('guest-wallet').waitFor();
        await check(context, 'wallet');

        await tab('투자모드').click();
        await page.getByTestId('guest-modes').waitFor();
        await check(context, 'modes');
        await page.getByTestId('guest-mode-beginner').scrollIntoViewIfNeeded();
        await check(context, 'modes-bottom');
        await page.getByTestId('guest-mode-beginner-start').click();
        await page.getByTestId('guest-mode-sign-in').waitFor();
        await check(context, 'modes-sign-in-sheet');
        await page.getByTestId('guest-mode-sign-in-signup').click();
        await page.getByTestId('auth-signup-screen').waitFor();
        assert.equal(await page.evaluate(() => window.fixture.isGuestBrowsing()), false);
        assert.equal(await page.getByRole('tab').count(), 0, 'the guest tabs are gone');

        const log = await page.evaluate(() => globalThis.guestLog);
        assert.deepEqual(log.credentialed.filter((p) => /trading-accounts|wallet|orders|positions|portfolio|\/fx\//.test(p)), [], 'no account read');
        assert.ok(log.public.every((p) => p.startsWith('/assets') || /^\/(futures\/instruments|fx\/rates\/current)/.test(p)), JSON.stringify(log.public));
        assert.equal(log.public.some((p) => p.startsWith('/futures/instruments')), true, 'the 선물 list asked the market-data route');
        if (!guestTypes) assert.deepEqual(log.public.length, log.refused.length, 'every market refused');
      }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ layouts, errors }, null, 2));
    console.log(JSON.stringify({ checks: layouts.length, errors, out }));
  } finally {
    await page.screenshot({ path: path.join(out, 'last-screen.png') }).catch(() => {});
    await browser.close();
    server.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
