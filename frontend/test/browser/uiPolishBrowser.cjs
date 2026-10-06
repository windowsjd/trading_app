// Production UI with the existing local transport fixtures. No external requests.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const { assertButtonFeedback } = require('./buttonFeedbackAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.UI_POLISH_OUTPUT ?? '/tmp/trading-ui-polish';
async function run() {
  fs.mkdirSync(out, { recursive: true });
  for (const fixture of ['rootTabs', 'friends', 'motion']) await esbuild.build({
    entryPoints: [path.join(__dirname, `${fixture}Fixture.jsx`)], outfile: path.join(out, `${fixture}.js`),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'existing-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      const filter = fixture === 'friends' ? /(^@react-navigation\/native$|services\/api\/client$|features\/auth\/useLogout$)/
        : fixture === 'motion' ? /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook)$/
        : /(services\/api\/client|navigationHooks|useMarketTickers)$/;
      b.onResolve({ filter }, () => ({ path: path.join(__dirname, `${fixture}Mocks.js`) }));
      if (fixture === 'motion') b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const fixture = req.url.startsWith('/friends') ? 'friends' : req.url.startsWith('/motion') ? 'motion' : 'rootTabs';
    const script = /^\/(rootTabs|friends|motion)\.js/.test(req.url);
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, `${fixture}.js`)) : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/${fixture}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  const records = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      // RN Web Animated uses Date.now. Keep the test clock monotonic when the
      // VM wall clock is corrected; native animation clocks are not tested here.
      const epoch = Date.now(), origin = performance.now();
      Date.now = () => epoch + Math.round(performance.now() - origin);
      const params = new URLSearchParams(location.search), pref = params.get('pref');
      if (pref !== 'keep') {
        if (pref === 'unset' || pref === 'fail') localStorage.removeItem('trading-app:appearance');
        else localStorage.setItem('trading-app:appearance', pref ?? 'system');
      }
      if (pref === 'fail') {
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function(key) { if (key === 'trading-app:appearance') throw Error('fixture storage failure'); return get.call(this, key); };
      }
      localStorage.setItem('selectedTradingAccountId:home-user', 'season-account');
      localStorage.setItem('trading-app:financial-colors', params.get('palette') ?? 'red_blue');
      window.motion = { events: [], commits: [], frames: [], shifts: [], geometry: [] };
    });
    const id = value => page.getByTestId(value).filter({ visible: true }).first();
    const bounds = locator => locator.evaluate(el => {
      const b = el.getBoundingClientRect(), text = el.querySelector('[dir="auto"]');
      const range = document.createRange(); range.selectNodeContents(text);
      const r = range.getBoundingClientRect();
      return { height: b.height, radius: getComputedStyle(el).borderRadius,
        inside: r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5 };
    });
    for (const mode of ['light', 'dark']) for (const width of (process.env.UI_POLISH_FEEDBACK_ONLY ? [] : [320, 360, 390, 430])) for (const fontScale of [1, 1.5, 2]) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: mode });
      const logoutStyles = [];
      for (const screen of ['home', 'my', 'settings', 'market', 'ranking', 'friends']) {
        await page.goto(`${base}/${screen === 'friends' ? 'friends' : 'rootTabs'}?screen=${screen}&holdings=1&fontScale=${fontScale}`);
        if (screen === 'my' || screen === 'settings') {
          const button = id(screen === 'my' ? 'my-logout-menu' : 'settings-logout'); await button.waitFor(); await button.scrollIntoViewIfNeeded();
          assert.equal(await button.getAttribute('role'), 'button'); assert.equal(await button.getAttribute('aria-label'), '로그아웃');
          const b = await bounds(button); assert.ok(b.inside); assert.equal(b.radius, '12px'); assert.ok(b.height >= 44);
          logoutStyles.push(await button.evaluate(el => {
            const label = getComputedStyle(el.querySelector('[dir="auto"]')), s = getComputedStyle(el.firstElementChild);
            return { stops: [...el.querySelectorAll('stop')].map(n => n.getAttribute('stop-color')), color: label.color,
              weight: label.fontWeight, padding: s.padding, radius: s.borderRadius };
          }));
          assert.deepEqual(logoutStyles.at(-1).stops, ['#D93636', '#B82020']);
          assert.equal(logoutStyles.at(-1).color, 'rgb(255, 255, 255)');
          if (fontScale === 1) await assertButtonFeedback(page, button);
        } else if (screen === 'home') {
          const button = id('home-holdings-toggle'); await button.waitFor(); await button.scrollIntoViewIfNeeded();
          const b = await bounds(button); assert.equal(b.radius, '12px'); assert.ok(b.inside); assert.ok(b.height >= 44);
          await button.click(); assert.equal(await button.getAttribute('aria-expanded'), 'true');
          await button.click(); assert.equal(await button.getAttribute('aria-expanded'), 'false');
        } else {
          const selected = page.locator('[role="tab"][aria-selected="true"]').first(); await selected.waitFor();
          const color = await selected.evaluate(el => ({ surface: getComputedStyle(el).backgroundColor, text: getComputedStyle(el.querySelector('[dir="auto"]')).color }));
          assert.equal(color.surface, mode === 'dark' ? 'rgb(32, 54, 74)' : 'rgb(234, 244, 252)');
          assert.equal(color.text, mode === 'dark' ? 'rgb(112, 175, 255)' : 'rgb(40, 91, 133)');
          assert.ok((await bounds(selected)).inside);
        }
        if (width === 390 && fontScale === 1) await page.screenshot({ path: path.join(out, `${screen}-${mode}.png`), fullPage: true });
        records.push({ mode, width, fontScale, screen });
      }
      assert.deepEqual(logoutStyles[0], logoutStyles[1], 'same logout presentation in both screens');
    }
    // Dark OS with no stored preference, invalid value and failed read all start light.
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const pref of ['unset', '', 'invalid', 'fail', 'light', 'dark', 'system']) {
      await page.goto(`${base}/rootTabs?screen=settings&pref=${pref}`); await id('settings-logout').waitFor();
      assert.equal(await page.evaluate(() => window.fixture.appearance.mode), ['dark', 'system'].includes(pref) ? 'dark' : 'light');
    }
    await page.goto(`${base}/rootTabs?screen=settings&pref=unset`); await id('settings-logout').waitFor();
    await page.evaluate(() => window.fixture.appearance.setPreference('dark'));
    await page.waitForFunction(() => localStorage.getItem('trading-app:appearance') === 'dark');
    await page.goto(`${base}/rootTabs?screen=settings&pref=keep`); await id('settings-logout').waitFor();
    assert.equal(await page.evaluate(() => window.fixture.appearance.mode), 'dark');
    await page.evaluate(() => window.fixture.appearance.setPreference('system'));
    await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => window.fixture.appearance.mode === 'light');
    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => window.fixture.appearance.mode === 'dark');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await assertButtonFeedback(page, id('settings-logout'), true);
    // Real CTA variants keep financial meaning and react to live Reduced Motion.
    for (const mode of ['light', 'dark']) for (const palette of ['red_blue', 'green_red']) {
      await page.emulateMedia({ colorScheme: mode, reducedMotion: 'no-preference' });
      await page.goto(`${base}/motion?primaryProbe=1&palette=${palette}`); await id('primary-wide').waitFor();
      for (const marker of ['primary-narrow', 'secondary-enabled', 'primary-buy', 'primary-sell']) {
        records.push({ mode, palette, marker, feedback: await assertButtonFeedback(page, id(marker)) });
      }
      await id('primary-wide').focus();
      await page.keyboard.press('Space');
      await page.waitForFunction(() => window.fixture.primaryCalls === 1);
      await id('primary-wide').click({ force: true });
      assert.equal(await page.evaluate(() => window.fixture.primaryCalls), 1);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      for (const marker of ['primary-narrow', 'secondary-enabled', 'primary-buy', 'primary-sell']) await assertButtonFeedback(page, id(marker), true);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ layouts: records.filter(r => r.screen).length, feedback: records.filter(r => r.feedback).length, errors, out }));
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ records, errors }, null, 2));
    await browser?.close(); server.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
