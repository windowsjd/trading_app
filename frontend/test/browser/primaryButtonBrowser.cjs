// Real RN Web rendering, existing screen fixtures and blocked external requests.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.PRIMARY_BROWSER_OUTPUT ?? '/tmp/trading-primary-browser';
const baselineRoot = process.env.PRIMARY_BASELINE_SOURCE;
const records = [], errors = [];
async function bundle(baseline) {
  await esbuild.build({ entryPoints: [path.join(__dirname, 'motionFixture.jsx')], outfile: path.join(out, baseline ? 'baseline.js' : 'primary.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, logLevel: 'warning',
    plugins: [{ name: 'primary-fixture', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook)$/ }, () => ({ path: path.join(__dirname, 'motionMocks.js') }));
      b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
      if (baseline) b.onLoad({ filter: /\/src\/.*\.(tsx|ts)$/ }, args => ({ loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
        contents: fs.readFileSync(path.join(baselineRoot, path.relative(root, args.path)), 'utf8') }));
    } }],
  });
}
async function run() {
  fs.mkdirSync(out, { recursive: true }); await Promise.all([bundle(false), ...(baselineRoot ? [bundle(true)] : [])]);
  const server = http.createServer((req, res) => {
    const script = /^\/(primary|baseline)\.js/.test(req.url);
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, req.url.split('?')[0])) : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/${req.url.includes('baseline=1') ? 'baseline' : 'primary'}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('selectedTradingAccountId:home-user', 'season-account');
      localStorage.setItem('trading-app:appearance', 'system');
      localStorage.setItem('trading-app:financial-colors', new URLSearchParams(location.search).get('palette') ?? 'red_blue');
      window.motion = { events: [], commits: [], frames: [], shifts: [], geometry: [] };
    });
    const id = value => page.getByTestId(value).filter({ visible: true }).first();
    async function visual(locator, name, expectedGradient = true, raster = false) {
      await locator.scrollIntoViewIfNeeded();
      if (expectedGradient) await page.waitForFunction(el => {
        for (let node = el; node; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < 1) return false;
        return true;
      }, await locator.elementHandle());
      const actual = await locator.evaluate(el => {
        const root = el.getBoundingClientRect(), style = getComputedStyle(el), svg = el.querySelector('svg');
        const texts = [...el.querySelectorAll('[dir="auto"]')].map(text => {
          const r = text.getBoundingClientRect(); return { color: getComputedStyle(text).color,
            inside: r.x >= root.x && r.right <= root.right + 0.5 && r.y >= root.y && r.bottom <= root.bottom + 0.5 };
        });
        const gradient = el.querySelector('linearGradient'), g = svg?.getBoundingClientRect();
        return { width: root.width, height: root.height, radius: style.borderRadius, opacity: style.opacity, background: style.backgroundColor,
          disabled: el.getAttribute('aria-disabled'), busy: el.getAttribute('aria-busy'), texts, svg: g ? { width: g.width, height: g.height } : null,
          gradient: gradient ? { units: gradient.getAttribute('gradientUnits'), points: ['x1','y1','x2','y2'].map(a => gradient.getAttribute(a)),
            stops: [...gradient.querySelectorAll('stop')].map(s => [s.getAttribute('offset'), s.getAttribute('stop-color'), s.getAttribute('stop-opacity')]),
            clipRadius: getComputedStyle(svg.parentElement).borderRadius, clipOverflow: getComputedStyle(svg.parentElement).overflow,
            pointerEvents: getComputedStyle(svg.parentElement).pointerEvents } : null };
      });
      assert.equal(!!actual.gradient, expectedGradient, `${name}: role`);
      if (expectedGradient) {
        assert.deepEqual(actual.gradient.stops, [['0%', '#326FE5', '1'], ['100%', '#7447D8', '1']], name);
        assert.deepEqual(actual.gradient.points, ['0%', '50%', '100%', '50%'], name);
        assert.equal(actual.gradient.units, 'objectBoundingBox'); assert.equal(actual.gradient.clipRadius, actual.radius);
        assert.equal(actual.gradient.clipOverflow, 'hidden'); assert.equal(actual.gradient.pointerEvents, 'none');
        assert.ok(Math.abs(actual.svg.width - actual.width) <= 2 && Math.abs(actual.svg.height - actual.height) <= 2, name);
        assert.ok(actual.texts.length > 0 && actual.texts.every(t => t.color === 'rgb(255, 255, 255)' && t.inside), `${name}: readable text`);
        if (raster) {
          const shot = await locator.screenshot({ path: path.join(out, `${name}.png`) });
          const pixels = await page.evaluate(async encoded => {
            const picture = new Image(); picture.src = `data:image/png;base64,${encoded}`; await picture.decode();
            const canvas = document.createElement('canvas'); canvas.width = picture.width; canvas.height = picture.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(picture, 0, 0);
            return [1, picture.width - 2].map(x => ({ x, width: picture.width, rgba: [...ctx.getImageData(x, Math.floor(picture.height / 2), 1, 1).data] }));
          }, shot.toString('base64'));
          for (const pixel of pixels) {
            const t = (pixel.x + 0.5) / pixel.width, expected = [50 + 66*t, 111 - 40*t, 229 - 13*t];
            assert.ok(expected.every((channel, i) => Math.abs(pixel.rgba[i] - channel) <= 2), `${name}: raster ${JSON.stringify(pixel)}`);
          }
          actual.raster = pixels;
        }
      }
      if (!expectedGradient && !name.startsWith('baseline-') && /disabled|blocked|loading/.test(name)) {
        await locator.screenshot({ path: path.join(out, `${name}.png`) });
      }
      records.push({ name, ...actual }); return actual;
    }
    const assertSecondary = (actual, mode) => {
      assert.equal(actual.background, mode === 'light' ? 'rgb(234, 244, 252)' : 'rgb(28, 48, 66)');
      assert.ok(actual.texts.every(text => text.color === (mode === 'light' ? 'rgb(40, 91, 133)' : 'rgb(185, 221, 252)') && text.inside));
    };
    for (const width of [320, 360, 390, 430, 768]) for (const scale of [1, 1.5, 2]) for (const mode of ['light', 'dark']) {
      const palette = mode === 'light' ? 'red_blue' : 'green_red', name = `${width}-${scale}-${mode}`;
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: mode });
      const before = {};
      if (baselineRoot) {
        await page.goto(`${base}/?primaryProbe=1&fontScale=${scale}&palette=${palette}&baseline=1`); await id('primary-wide').waitFor();
        for (const marker of ['primary-wide','primary-narrow','primary-long','primary-disabled','primary-loading','primary-buy','primary-sell','primary-selected','primary-lesson']) {
          before[marker] = await visual(id(marker), `baseline-${name}-${marker}`, false);
        }
      }
      await page.goto(`${base}/?primaryProbe=1&fontScale=${scale}&palette=${palette}`); await id('primary-wide').waitFor();
      for (const marker of ['primary-wide','primary-narrow','primary-long','primary-lesson']) {
        const after = await visual(id(marker), `${name}-${marker}`, true, marker !== 'primary-lesson');
        if (before[marker]) { assert.equal(after.width, before[marker].width, `${marker}: width unchanged`); assert.equal(after.height, before[marker].height, `${marker}: height unchanged`); }
      }
      for (const marker of ['primary-disabled','primary-blocked','primary-loading','primary-neutral','primary-buy','primary-sell','primary-selected','primary-lesson-selected','primary-lesson-secondary','primary-lesson-financial']) {
        const after = await visual(id(marker), `${name}-${marker}`, false);
        if (before[marker]) for (const key of ['width','height','background','opacity','disabled','busy']) assert.equal(after[key], before[marker][key], `${marker}: preserved ${key}`);
      }
      for (const state of ['enabled', 'disabled', 'blocked', 'loading']) {
        const actual = await visual(id(`secondary-${state}`), `${name}-secondary-${state}`, false);
        assertSecondary(actual, mode);
        if (state !== 'enabled') assert.equal(actual.disabled, 'true');
        if (state === 'disabled' || state === 'blocked') assert.equal(actual.opacity, '0.45');
        if (state === 'loading') {
          assert.equal(actual.busy, await id('primary-loading').getAttribute('aria-busy'), 'existing RN Web loading semantics are shared');
          assert.equal(await id('secondary-loading').getByRole('progressbar').count(), 1);
        }
      }
      if (width === 390 && scale === 1) {
        const primary = id('primary-wide'); await primary.scrollIntoViewIfNeeded();
        const box = await primary.boundingBox(); await page.mouse.move(box.x + 14, box.y + 14); await page.mouse.down(); await page.waitForTimeout(200);
        assert.equal(await primary.evaluate(el => Number(getComputedStyle(el.children[1]).opacity)), 0.055, 'original single pressed wash');
        await primary.screenshot({ path: path.join(out, `${mode}-pressed.png`) }); await page.mouse.up();
        await page.waitForFunction(() => window.fixture.primaryCalls === 1);
        assert.equal((await visual(primary, `${mode}-submit-loading`, false)).disabled, 'true');
        assert.equal(await primary.getByRole('progressbar').count(), 1); await primary.click({ force: true });
        assert.equal(await page.evaluate(() => window.fixture.primaryCalls), 1, 'loading blocks duplicate submission');
        await page.evaluate(() => window.fixture.finishPrimary());
        await page.waitForFunction(() => document.querySelector('[data-testid="primary-wide"]')?.getAttribute('aria-disabled') !== 'true');
        await primary.focus(); assert.equal(await primary.evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => window.fixture.primaryCalls === 2); await page.evaluate(() => window.fixture.finishPrimary());
        await page.emulateMedia({ reducedMotion: 'reduce' }); await visual(primary, `${mode}-reduced-motion`); await page.emulateMedia({ reducedMotion: 'no-preference' });
      }
    }
    // Resize the same mounted controls, without choosing per-width gradient values.
    for (const width of [430, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await visual(id('primary-wide'), `resize-${width}-wide`, true, true);
      await visual(id('primary-narrow'), `resize-${width}-narrow`, true, true);
    }
    for (const width of [320, 360, 390, 430]) for (const scale of [1, 1.5, 2])
      for (const mode of ['light', 'dark']) for (const preference of ['red_blue', 'green_red']) for (const kind of ['quantity', 'limit', 'full']) {
        await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: mode });
        await page.goto(`${base}/?orderProbe=${kind}&fontScale=${scale}&palette=${preference}`);
        const history = page.getByRole('button', { name: '주문내역 보기', exact: true });
        if (kind !== 'full') {
          assertSecondary(await visual(history, `${mode}-${width}-${scale}-${preference}-${kind}-history`, false), mode);
          await history.click();
          assert.equal(await page.evaluate(() => window.fixture.orderAction), 'history');
        } else {
          assert.equal(await history.count(), 0);
          await visual(page.getByRole('button', { name: '종목 상세로 돌아가기', exact: true }), `${mode}-${width}-${scale}-${preference}-full-neutral`, false);
        }
        const home = page.getByRole('button', { name: '홈으로 가기', exact: true });
        await visual(home, `${mode}-${width}-${scale}-${preference}-${kind}-home`);
        await home.click();
        assert.equal(await page.evaluate(() => window.fixture.orderAction), 'home');
        if (width === 320 && scale === 2 && preference === 'red_blue') await page.screenshot({ path: path.join(out, `${mode}-${kind}-order-large-font.png`) });
      }
    for (const mode of ['light', 'dark']) {
      await page.setViewportSize({ width: 390, height: 900 }); await page.emulateMedia({ colorScheme: mode });
      await page.goto(`${base}/?account=season&holdings=1&navigation=1&fxState=available`); await id('home-total-asset').waitFor();
      await page.evaluate(() => window.fixture.navigationRef.navigate('SeasonJoin'));
      await page.waitForFunction(() => window.fixture.client.getQueryData(['season', 'current']));
      await page.evaluate(() => window.fixture.client.setQueryData(['season','current'], current => ({ ...current, joined: false })));
      await visual(page.getByRole('button', { name: '시즌 참가하기', exact: true }).filter({ visible: true }).first(), `${mode}-season-join`, true, true);
      await page.screenshot({ path: path.join(out, `${mode}-season-screen.png`) });
      await page.evaluate(() => window.fixture.navigationRef.navigate('MainTabs', { screen: 'WalletTab', params: { screen: 'WalletFx' } }));
      await id('wallet-fx-amount-input').fill('10000');
      await page.waitForFunction(() => document.querySelector('[data-testid="wallet-fx-execute-submit"]')?.getAttribute('aria-disabled') !== 'true');
      await visual(id('wallet-fx-execute-submit'), `${mode}-fx`, true, true); await visual(id('wallet-fx-direction-krw-usd'), `${mode}-fx-selected`, false);
      await page.screenshot({ path: path.join(out, `${mode}-fx-screen.png`) });
      await page.evaluate(() => window.fixture.navigationRef.navigate('MainTabs', { screen: 'MyTab', params: { screen: 'Record', params: { screen: 'RecordSeasonDetail', params: { seasonId: 'record-0' } } } }));
      await visual(id('record-season-detail-profit-analysis-cta'), `${mode}-record-narrow`, true, true);
      await page.screenshot({ path: path.join(out, `${mode}-record-screen.png`) });
      await page.evaluate(() => window.fixture.navigationRef.navigate('AuthStack', { screen: 'Login' }));
      await visual(id('auth-login-submit'), `${mode}-login`, true, true);
      await page.screenshot({ path: path.join(out, `${mode}-login-screen.png`) });
      await page.getByText('회원가입', { exact: true }).filter({ visible: true }).click(); await visual(id('auth-signup-submit'), `${mode}-signup`, true, true);
      await page.screenshot({ path: path.join(out, `${mode}-signup-screen.png`) });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ baselineSource: baselineRoot ?? null, baselineHead: process.env.PRIMARY_BASELINE_HEAD ?? null, status: 'PASS', previewImage: 'NOT_PROVIDED', android: 'NOT_RUN', ios: 'NOT_RUN', errors, records }, null, 2));
    console.log(`PASS: ${records.length} rendered button checks; screenshots: ${out}`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, errors, records, body: await page?.locator('body').innerText() }, null, 2)); throw error;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
