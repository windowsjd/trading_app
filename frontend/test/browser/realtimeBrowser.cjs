// Actual screens, shared manager, channel hooks, role gate and RN Web text geometry.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.REALTIME_BROWSER_OUTPUT ?? '/tmp/trading-realtime-browser';
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'realtimeFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, logLevel: 'warning',
    plugins: [{ name: 'isolated-runtime-transport', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: path.join(__dirname, 'realtimeMocks.js') }));
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|constants\/env|storage\/tokenStorage)$/ }, () => ({ path: path.join(__dirname, 'realtimeMocks.js') }));
    } }],
  });
  const server = http.createServer((req, res) => {
    const js = req.url === '/bundle.js';
    res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(js ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser; const records = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const panels = () => page.getByTestId('admin-diagnostic-panel');
    const open = async (screen, role, width = 320, fontScale = 2) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/?screen=${screen}&role=${role}&fontScale=${fontScale}&asset=SUI`);
      await page.waitForFunction(() => window.runtimeHarness?.sockets.length === 1);
      await page.evaluate(() => window.runtimeHarness.open());
      await page.waitForFunction(() => window.runtimeHarness.sockets[0].frames.length > 0);
      await page.waitForTimeout(50);
    };
    for (const screen of ['market', 'chart', 'order', 'fx']) {
      for (const role of ['user', 'operator', 'unknown', 'error', 'admin']) {
        await open(screen, role);
        // Auth failure is terminal, so assertions do not race the reconnect clock.
        await page.evaluate(() => window.runtimeHarness.drop(1008));
        if (role === 'admin') {
          await panels().first().waitFor();
          const toggle = page.getByTestId('admin-diagnostic-toggle').first(); await toggle.click();
          const text = (await panels().first().innerText()).replace(/\u200b/g, '');
          assert.match(text, /auth_failed/); assert.match(text, /1008/);
        } else {
          await page.waitForTimeout(100);
          assert.equal(await panels().count(), 0, `${screen}/${role} hidden`);
        }
        assert.equal(await page.evaluate(() => window.runtimeHarness.sockets.length), 1);
        records.push({ screen, role, gate: true });
      }
      for (const appearance of ['light', 'dark']) for (const width of [320, 390, 768]) for (const fontScale of [1, 2]) {
        await page.emulateMedia({ colorScheme: appearance });
        await open(screen, 'admin', width, fontScale);
        await page.evaluate(() => {
          for (const frame of window.runtimeHarness.sockets[0].frames.filter(f => f.type === 'subscribe')) {
            window.runtimeHarness.receive({ ...frame, type: 'subscribed' });
            if (frame.channel === 'asset_candle') window.runtimeHarness.receive({ ...frame, type: 'resync_required', code: 'CANDLE_PUBSUB_RECOVERED' });
            if (frame.channel === 'asset_order_book') window.runtimeHarness.receive({ ...frame, type: 'subscription_error', code: 'ORDER_BOOK_UNAVAILABLE' });
          }
          window.runtimeHarness.drop(1008);
        });
        await panels().first().waitFor();
        for (const toggle of await page.getByTestId('admin-diagnostic-toggle').all()) await toggle.click();
        const clipped = await panels().evaluateAll(els => {
          const failures = [];
          for (const panel of els) {
            const box = panel.getBoundingClientRect();
            for (const text of panel.querySelectorAll('[dir="auto"]')) {
              const range = document.createRange(); range.selectNodeContents(text);
              for (const rect of range.getClientRects()) if (rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1)) failures.push(text.textContent);
            }
          }
          return failures;
        });
        assert.deepEqual(clipped, [], `${screen} ${width}px font ${fontScale}: no clipped glyphs`);
        const text = (await panels().first().innerText()).replace(/\u200b/g, '');
        assert.match(text, /lastTransitionAt/); assert.match(text, /auth_failed_close/);
        assert.doesNotMatch(text, /fixture-private-token|ws:\/\//);
        const frames = await page.evaluate(() => window.runtimeHarness.sockets[0].frames);
        const keys = frames.filter(f => f.type === 'subscribe').map(f => `${f.channel}|${f.assetId ?? f.pair}|${f.interval ?? ''}`);
        assert.equal(new Set(keys).size, keys.length, 'no diagnostic duplicate subscribe');
        const reads = await page.evaluate(() => window.runtimeHarness.state.reads);
        assert.equal(reads.filter(p => p === '/me').length, 1, 'existing role cache shared');
        if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `${screen}-${appearance}-320-2.png`), fullPage: true });
        records.push({ screen, appearance, width, fontScale, frames: frames.length, glyphBounds: true });
      }
    }
    // Clock-driven end-to-end states use the production timers/policies.
    await page.clock.install();
    await open('order', 'admin', 320, 2);
    await page.evaluate(() => {
      const frame = window.runtimeHarness.sockets[0].frames.find(f => f.channel === 'asset_order_book');
      window.runtimeHarness.receive({ ...frame, type: 'subscribed' });
    });
    await page.clock.runFor(10250);
    await page.getByTestId('admin-diagnostic-toggle').first().click();
    assert.match((await panels().first().innerText()).replace(/\u200b/g, ''), /first_snapshot_timeout/);
    await page.evaluate(() => window.runtimeHarness.receive({ type: 'asset_order_book', assetId: 'SUI',
      asks: [{ price: '1.1', quantity: '1' }], bids: [{ price: '1', quantity: '1' }],
      priceUnit: 'USDT', quantityUnit: 'SUI', capturedAt: new Date().toISOString() }));
    await panels().first().waitFor({ state: 'detached' });
    await page.clock.runFor(5250);
    await page.getByTestId('admin-diagnostic-toggle').first().click();
    assert.match((await panels().first().innerText()).replace(/\u200b/g, ''), /freshness_timeout/);
    assert.equal(await page.evaluate(() => window.runtimeHarness.sockets[0].frames.length), 2);
    records.push({ screen: 'order', flow: 'ACK-timeout-first-snapshot-stale', passed: true });

    await open('chart', 'admin');
    await page.evaluate(() => {
      const frame = window.runtimeHarness.sockets[0].frames.find(f => f.channel === 'asset_candle');
      window.runtimeHarness.receive({ ...frame, type: 'subscribed' });
      window.runtimeHarness.receive({ ...frame, type: 'candle_stale', code: 'CANDLE_OVERLAY_READ_FAILED' });
    });
    await page.getByTestId('admin-diagnostic-toggle').first().click();
    assert.match((await panels().first().innerText()).replace(/\u200b/g, ''), /server_candle_stale/);
    assert.match((await panels().first().innerText()).replace(/\u200b/g, ''), /CANDLE_OVERLAY_READ_FAILED/);
    await page.evaluate(() => {
      const frame = window.runtimeHarness.sockets[0].frames.find(f => f.channel === 'asset_candle');
      window.runtimeHarness.receive({ ...frame, type: 'asset_candle', sequence: 1, revision: 1,
        provisional: true, complete: false, final: false, delayed: true, sourceUpdatedAt: '2000-01-01T00:00:00Z',
        candle: { time: '2026-10-05T00:00:00Z', closeTime: '2026-10-05T00:05:00Z',
          open: '1', high: '2', low: '0.5', close: '1.5', volume: '1' } });
    });
    await panels().first().waitFor({ state: 'detached' });
    await page.clock.runFor(30000);
    await page.getByTestId('admin-diagnostic-toggle').first().click();
    const candleText = (await panels().first().innerText()).replace(/\u200b/g, '');
    assert.match(candleText, /freshness_timeout/); assert.match(candleText, /client_receipt/);
    records.push({ screen: 'chart', flow: 'server-control-valid-delayed-timeout', passed: true });

    await open('fx', 'admin');
    const initialReads = await page.evaluate(() => window.runtimeHarness.state.reads.filter(p => p === '/fx/rates/current').length);
    await page.evaluate(() => {
      const frame = window.runtimeHarness.sockets[0].frames.find(f => f.channel === 'fx_rate');
      window.runtimeHarness.receive({ ...frame, type: 'subscribed' });
    });
    await page.waitForFunction(expected => window.runtimeHarness.state.reads.filter(p => p === '/fx/rates/current').length === expected,
      initialReads + 1);
    await page.evaluate(() => window.runtimeHarness.receive({ type: 'fx_rate_updated', channel: 'fx_rate', pair: 'USD/KRW', rate: '99999' }));
    await page.waitForFunction(expected => window.runtimeHarness.state.reads.filter(p => p === '/fx/rates/current').length === expected,
      initialReads + 2);
    await page.evaluate(() => window.runtimeHarness.drop(1008));
    await page.getByTestId('admin-diagnostic-toggle').first().click();
    const fxText = (await panels().first().innerText()).replace(/\u200b/g, '');
    assert.match(fxText, /lastFxUpdateReceivedAt/); assert.match(fxText, /fx_rate_updated/);
    assert.match(fxText, /lastResyncCompletedAt/); assert.doesNotMatch(await page.locator('body').innerText(), /99999/);
    records.push({ screen: 'fx', flow: 'ACK-update-REST-source', passed: true });

    await open('market', 'admin');
    await page.evaluate(() => {
      const frames = window.runtimeHarness.sockets[0].frames.filter(f => f.channel === 'asset_ticker');
      window.runtimeHarness.receive({ ...frames[0], type: 'subscribed' });
      window.runtimeHarness.receive({ type: 'asset_ticker', assetId: frames[0].assetId, priceLocal: '1', priceKrw: '1350',
        priceKrwState: 'available', assetPriceSnapshotId: 'one', priceCapturedAt: new Date().toISOString() });
      window.runtimeHarness.receive({ ...frames[1], type: 'subscription_error', code: 'SUBSCRIPTION_LIMIT' });
    });
    await page.getByTestId('admin-diagnostic-toggle').first().click();
    const marketText = (await panels().first().innerText()).replace(/\u200b/g, '');
    assert.match(marketText, /lastMarketSubscriptionErrorAssetId/); assert.match(marketText, /SUBSCRIPTION_LIMIT/);
    assert.match(marketText, /connected/);
    records.push({ screen: 'market', flow: 'other-row-subscription-error', passed: true });

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ records, errors }, null, 2));
    console.log(`PASS: ${records.length} runtime role/layout cases; artifacts: ${out}`);
  } finally { await browser?.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
