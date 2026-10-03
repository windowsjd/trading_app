// Browser timing evidence only: route-state != native transition onset; RAF !=
// native frame pacing. Uses installed navigators, real screens and React Query.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.MOTION_BROWSER_OUTPUT ?? '/tmp/trading-motion-browser';
async function run() {
  fs.mkdirSync(out, { recursive: true });
  if (!process.env.MOTION_REUSE_BUNDLE) await esbuild.build({ entryPoints: [path.join(__dirname, 'motionFixture.jsx')], outfile: path.join(out, 'motion.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')], resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'], define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, plugins: [{ name: 'motion-fixture', setup(b) {
    b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: require.resolve('react-dom/profiling', { paths: [root] }) }));
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
    b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook)$/ }, () => ({ path: path.join(__dirname, 'motionMocks.js') }));
    b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    // Instrument the real action only in this test bundle, before its handler.
    b.onLoad({ filter: /ActionPressable\.tsx$/ }, args => ({ loader: 'tsx', contents: fs.readFileSync(args.path, 'utf8').replace('onPress={onPress}', 'onPress={(event) => { window.motion.events.push({ stage: "T2", time: performance.now() }); onPress?.(event); }}') }));
    b.onLoad({ filter: /FullPageLoading\.tsx$/ }, args => ({ loader: 'tsx', contents: fs.readFileSync(args.path, 'utf8').replace('<SafeAreaView ', '<SafeAreaView testID="motion-loading-shell" ') }));
  } }], logLevel: 'warning' });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/motion.js'); res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'motion.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/motion.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], records = [], probes = [], base = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('selectedTradingAccountId:home-user', `${new URLSearchParams(location.search).get('account') ?? 'general'}-account`);
    localStorage.setItem('trading-app:appearance', 'system');
    window.motion = { events: [], commits: [], frames: [], shifts: [] };
    document.addEventListener('pointerdown', () => window.motion.events.push({ stage: 'T0', time: performance.now() }), true);
    document.addEventListener('click', () => window.motion.events.push({ stage: 'click', time: performance.now() }), true);
    let previous;
    const frame = time => { if (previous) window.motion.frames.push({ time, duration: time - previous }); previous = time; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    new PerformanceObserver(list => { for (const e of list.getEntries()) window.motion.shifts.push({ time: e.startTime, value: e.value, recentInput: e.hadRecentInput, sources: e.sources.map(s => ({ testID: s.node?.closest?.('[data-testid]')?.getAttribute('data-testid'), text: s.node?.textContent?.slice(0, 60), previous: s.previousRect.toJSON(), current: s.currentRect.toJSON() })) }); }).observe({ type: 'layout-shift', buffered: true });
  });
  const id = value => page.getByTestId(value);
  const pause = ms => page.waitForTimeout(ms); // browser observation window, not a benchmark threshold
  const reset = () => page.evaluate(() => { for (const list of Object.values(window.motion)) list.length = 0; window.fixture.timing.requests.length = 0; });
  const back = async () => { await page.evaluate(() => window.fixture.navigationRef.goBack()); await pause(180); };
  async function step(flow, locator, destination, data, condition) {
    await locator.scrollIntoViewIfNeeded(); await pause(180); await reset();
    await page.evaluate(({ destination, data }) => {
      const observe = () => { for (const [stage, selector] of [['shell-dom', destination], ['data-dom', data]]) {
        const visible = value => [...document.querySelectorAll(`[data-testid="${value}"]`)].some(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
        const actionStarted = window.motion.events.some(e => e.stage === 'click' || e.stage === 'T2');
        if (selector && actionStarted && (visible(selector) || (stage === 'shell-dom' && visible('motion-loading-shell'))) && !window.motion.events.some(e => e.stage === stage)) window.motion.events.push({ stage, time: performance.now() });
      } };
      window.motionObserver?.disconnect(); window.motionObserver = new MutationObserver(observe); window.motionObserver.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true });
    }, { destination, data });
    // A fixed 35 ms hold separates physical-event dispatch from handler time.
    const box = await locator.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await pause(35); await page.mouse.up();
    await id(destination).first().waitFor(); if (data) await id(data).first().waitFor();
    await pause(700);
    const record = await page.evaluate(() => ({ ...window.motion, requests: window.fixture.timing.requests, observerCounts: window.fixture.client.getQueryCache().getAll().filter(q => q.getObserversCount()).map(q => ({ key: q.queryKey, count: q.getObserversCount() })) }));
    const onset = record.events.find(e => e.stage === 'T2') ?? record.events.find(e => e.stage === 'click');
    const route = record.events.find(e => e.stage === 'route-state');
    assert.ok(onset && route, `${flow}: action and route state must be observed`);
    if (condition === 'delayed' && record.requests.length) {
      const response = Math.min(...record.requests.map(r => r.response ?? Infinity));
      assert.ok(route.time < response, `${flow}: route opens before delayed transport completes`);
    }
    if (condition === 'cache') assert.equal(record.requests.length, 0, `${flow}: revisit uses the fresh cache`);
    if (!process.env.MOTION_REUSE_BUNDLE && condition === 'delayed' &&
      ['Market → AssetDetail', 'SeasonDetail → ProfitAnalysis'].includes(flow)) {
      for (const shift of record.shifts) for (const source of shift.sources) {
        assert.equal(source.current.y, source.previous.y, `${flow}: delayed data must not push visible content down`);
      }
    }
    records.push({ flow, condition, ...record, handlerToRouteMs: route.time - onset.time, nativeT1: null, nativeT3: null, nativeT4: null });
  }
  try {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion }); await page.goto(`${base}/?probe=1`); await id('motion-probe').waitFor(); await pause(100); await reset();
      const box = await id('motion-probe').boundingBox(); await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down(); await pause(35); await page.mouse.up(); await pause(600);
      probes.push({ reducedMotion, ...await page.evaluate(() => window.motion) });
      await page.screenshot({ path: path.join(out, `probe-${reducedMotion}.png`) });
      await page.mouse.down(); await pause(100);
      await page.screenshot({ path: path.join(out, `probe-${reducedMotion}-pressed.png`) });
      await page.mouse.up();
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const condition of (process.env.MOTION_CONDITIONS?.split(',') ?? ['fixture', 'delayed', 'cache'])) {
      if (condition !== 'cache') { await page.goto(`${base}/?navigation=1&holdings=1`); await id('home-total-asset').waitFor(); }
      await page.evaluate(delay => { window.fixture.timing.delay = delay; }, condition === 'fixture' ? 0 : 600);
      await step('Home → Market tab', page.getByRole('tab', { name: '마켓', exact: true }), 'market-screen', 'market-item-asset-0', condition);
      await step('Market → AssetDetail', id('market-item-asset-0'), 'asset-order-actions', 'asset-settlement-currency', condition);
      await step('AssetDetail → Order', id('asset-detail-open-buy-order'), 'order-screen', 'order-quantity-input', condition);
      await step('Order → Back', page.locator('[aria-label$="back"]:visible').first(), 'asset-order-actions', 'asset-timeframe-selector', condition);
      await back();
      await step('Market → Guide tab', page.getByRole('tab', { name: '가이드', exact: true }), 'guide-screen', 'guide-screen', condition);
      await step('Guide → Wallet tab', page.getByRole('tab', { name: '지갑', exact: true }), 'wallet-composition', 'wallet-orders', condition);
      await step('Wallet → FX', id('wallet-exchange'), 'wallet-fx-screen', null, condition); await back();
      await step('Wallet → TradeHistory', id('wallet-orders'), 'record-order-list-screen', null, condition); await back();
      await step('Wallet → Overall tab', page.getByRole('tab', { name: '전체', exact: true }), 'overall-Record', 'overall-Record', condition);
      await step('Overall → Record', id('overall-Record'), 'record-season-item-record-0', 'record-season-item-record-0', condition);
      await step('Record → SeasonDetail', id('record-season-item-record-0'), 'record-season-detail-screen', 'record-detail-return', condition);
      await step('SeasonDetail → ProfitAnalysis', id('record-season-detail-profit-analysis-cta'), 'record-profit-analysis-screen', 'record-profit-total', condition); await back(); await back(); await back();
      await step('Overall → Home tab', page.getByRole('tab', { name: '홈', exact: true }), 'home-total-asset', 'home-total-asset', condition);
      await step('Home → AssetDetail', id('home-position-item-general-account-asset-0'), 'asset-order-actions', 'asset-settlement-currency', condition); await back();
      await page.getByRole('tab', { name: '홈', exact: true }).click(); await pause(180);
    }
    await page.goto(`${base}/?navigation=1&holdings=1&account=season`); await id('home-total-asset').waitFor();
    await step('Home → Ranking tab', page.getByRole('tab', { name: '랭킹', exact: true }), 'ranking-screen', null, 'season-fixture');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await pause(100);
    await step('Ranking → Wallet tab (Reduced Motion)', page.getByRole('tab', { name: '지갑', exact: true }), 'wallet-composition', 'wallet-orders', 'season-reduced');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ scope: 'RN Web with deterministic transport; native animation and live API NOT_VERIFIED', records, probes, errors }, null, 2));
    console.log(`MOTION_BROWSER_PASSED ${records.length} interactions, ${probes.length} press probes`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, errors, records, probes, body: await page.locator('body').innerText() }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png') }); throw error;
  } finally { await browser.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exit(1); });
