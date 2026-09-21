// Optional browser regression runner. Needs esbuild + Playwright on NODE_PATH.
// Fixtures never use credentials or contact production. Actual screens, query
// cache, API wrappers, RN Web, SVG renderer and pointer adapter are bundled.
const path = require('node:path'),
  fs = require('node:fs'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const esbuild = require('esbuild'),
  { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'),
  out =
    process.env.TRADING_BROWSER_OUTPUT ?? '/tmp/trading-ui-followup/browser';
const mocks = path.join(__dirname, 'tradingMocks.js');
async function build() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'tradingFixture.jsx')],
    outfile: path.join(out, 'bundle.js'),
    bundle: true,
    minify: true,
    platform: 'browser',
    format: 'iife',
    nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: [
      '.web.tsx',
      '.tsx',
      '.web.ts',
      '.ts',
      '.web.js',
      '.js',
      '.jsx',
      '.json',
    ],
    mainFields: ['browser', 'module', 'main'],
    define: {
      global: 'globalThis',
      'process.env.NODE_ENV': '"production"',
      __DEV__: 'false',
      'process.env.EXPO_PUBLIC_LIMIT_ORDER_ENABLED': '"false"',
    },
    loader: { '.png': 'dataurl' },
    plugins: [
      {
        name: 'isolated-trading-boundaries',
        setup(b) {
          b.onResolve({ filter: /^react-native$/ }, () => ({
            path: path.join(__dirname, 'nativeWeb.jsx'),
          }));
          b.onResolve(
            { filter: /^@react-navigation\/(native|elements)$/ },
            () => ({ path: mocks }),
          );
          b.onResolve(
            {
              filter:
                /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useMarketTickers)$/,
            },
            () => ({ path: mocks }),
          );
          b.onResolve({ filter: /CandlestickChartRenderer$/ }, (args) =>
            args.importer.endsWith('rendererProbe.jsx')
              ? undefined
              : { path: path.join(__dirname, 'rendererProbe.jsx') },
          );
        },
      },
    ],
    logLevel: 'warning',
  });
  fs.writeFileSync(
    path.join(out, 'index.html'),
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}body{font-family:sans-serif}</style><div id="root"></div><script src="/bundle.js"></script>',
  );
}
async function run() {
  await build();
  const server = http
    .createServer((req, res) => {
      res.setHeader(
        'Content-Type',
        req.url.startsWith('/bundle.js') ? 'text/javascript' : 'text/html',
      );
      res.end(
        fs.readFileSync(
          path.join(
            out,
            req.url.startsWith('/bundle.js') ? 'bundle.js' : 'index.html',
          ),
        ),
      );
    })
    .listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });
  const errors = [];
  const records = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  const base = 'http://127.0.0.1:' + server.address().port;
  await page.route('**/*', (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort(),
  );
  const id = (value) => page.getByTestId(value);
  const open = async (query = '') => {
    await page.goto(base + '/?' + query);
    await page.waitForFunction(() => !!window.fixture);
  };
  try {
    await open();
    await id('inline-order-panel').waitFor();
    await page.screenshot({
      path: path.join(out, 'initial.png'),
      fullPage: true,
    });
    console.log('INITIAL_BROWSER_READY');
    const geometry = async () =>
      JSON.parse(await page.locator('#geometry').textContent());
    const controls = [
      'order-type-toggle-market',
      'order-type-toggle-limit',
      'order-ratio-25',
      'order-ratio-50',
      'order-ratio-75',
      'order-ratio-100',
      'order-execute-submit',
      'holdings-filter-all',
      'holdings-filter-current',
    ];
    for (const width of [320, 360, 390, 430])
      for (const fontScale of [1, 1.5])
        for (const asset of ['BTC', 'BNB', 'PEPE', 'SUI', '币安人生']) {
          await page.setViewportSize({ width, height: 844 });
          await open(
            'asset=' + encodeURIComponent(asset) + '&fontScale=' + fontScale,
          );
          await id('order-type-toggle-limit').waitFor();
          assert.match(
            await page.locator('body').innerText(),
            /전일대비 \+1.01%/,
          );
          assert.doesNotMatch(
            await page.locator('body').innerText(),
            /실시간 연결 복구|실시간 시세 최신성/,
          );
          assert.match(
            await id('asset-pair-header').innerText(),
            new RegExp(asset + ' / USD'),
          );
          for (const name of controls) {
            const failures = await id(name).evaluate((root) => {
              const box = root.getBoundingClientRect();
              return [...root.querySelectorAll('[dir="auto"]')]
                .filter((n) => n.textContent)
                .flatMap((n) => {
                  const b = n.getBoundingClientRect();
                  return b.left < box.left - 1 ||
                    b.right > box.right + 1 ||
                    b.top < box.top - 1 ||
                    b.bottom > box.bottom + 1
                    ? [n.textContent]
                    : [];
                });
            });
            assert.deepEqual(
              failures,
              [],
              name + ' clipped at ' + width + '/' + fontScale,
            );
          }
          const filter = await id('holdings-filter-all').boundingBox();
          assert.ok(filter.width < width / 2, 'compact filter');
          await id('order-type-toggle-limit').click();
          await id('order-ratio-25').click();
          assert.match(
            await page.locator('body').innerText(),
            /지정가를 입력하면 비율 수량/,
          );
          await id('order-limit-price-input').fill('100');
          await id('order-ratio-25').click();
          assert.ok(Number(await id('order-quantity-input').inputValue()) > 0);
          await id('order-type-toggle-market').click();
          assert.equal(await id('order-limit-price-input').count(), 0);
          await id('asset-detail-sell-button').click();
          assert.equal(await id('order-quote-submit').count(), 0);
          assert.equal(await id('order-execute-submit').innerText(), '매도');
          await id('order-ratio-100').click();
          assert.equal(await id('order-quantity-input').inputValue(), '4');
          if (asset === 'SUI')
            await page.screenshot({
              path: path.join(out, `detail-${width}-${fontScale}.png`),
              fullPage: true,
            });
          records.push({ kind: 'layout', width, fontScale, asset });
        }
    for (const role of ['user', 'operator', 'admin', 'unknown', 'error']) {
      await open('role=' + role);
      await id('inline-order-panel').waitFor();
      assert.equal(
        (await page.locator('body').innerText()).includes('실시간 연결 복구'),
        role === 'admin',
      );
      assert.equal(
        (await page.evaluate(() => window.fixture.state.reads)).filter(
          (p) => p === '/me',
        ).length,
        1,
        'one shared role query',
      );
      records.push({ kind: 'role-guard', role });
    }
    for (const width of [320, 390, 768])
      for (const fontScale of [1, 1.5, 2]) {
        await page.setViewportSize({ width, height: 844 });
        await open('asset=BNB&fontScale=' + fontScale);
        await id('inline-order-panel').waitFor();
        await id('asset-detail-sell-button').click();
        const column = await id('asset-order-column').boundingBox();
        const boxes = await Promise.all(
          [25, 50, 75, 100].map((p) => id('order-ratio-' + p).boundingBox()),
        );
        for (const box of [
          ...boxes,
          await id('order-quantity-slider').boundingBox(),
        ]) {
          assert.ok(
            box.x >= column.x - 1 &&
              box.x + box.width <= column.x + column.width + 1,
            'quantity controls fit column',
          );
        }
        if (fontScale === 1)
          assert.equal(
            new Set(boxes.map((box) => box.y)).size,
            1,
            'compact presets occupy one row',
          );
        await id('order-ratio-50').click();
        assert.equal(await id('order-quantity-slider').inputValue(), '50');
        assert.equal(await id('order-quantity-input').inputValue(), '2');
        assert.equal(
          await id('order-ratio-50').evaluate(
            (el) => getComputedStyle(el).backgroundColor,
          ),
          'rgb(32, 42, 53)',
        );
        await id('order-quantity-slider').focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await id('order-quantity-input').inputValue(), '2.04');
        assert.equal(
          await id('order-ratio-50').getAttribute('aria-pressed'),
          'false',
        );
        await page.keyboard.press('End');
        assert.equal(await id('order-quantity-input').inputValue(), '4');
        await page.keyboard.press('Home');
        assert.equal(await id('order-quantity-input').inputValue(), '');
        const bar = await id('order-quantity-slider').boundingBox();
        await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
        assert.equal(await id('order-quantity-input').inputValue(), '2');
        await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
        await page.mouse.down();
        await page.mouse.move(bar.x + bar.width + 20, bar.y + bar.height / 2, {
          steps: 4,
        });
        assert.equal(
          await id('order-quantity-input').inputValue(),
          '4',
          'quantity changes during drag',
        );
        await page.mouse.move(bar.x - 20, bar.y + bar.height / 2, { steps: 4 });
        await page.mouse.up();
        assert.equal(await id('order-quantity-input').inputValue(), '');
        await id('order-quantity-input').fill('1.48');
        assert.equal(await id('order-quantity-slider').inputValue(), '37');
        for (const p of [25, 50, 75, 100])
          assert.equal(
            await id('order-ratio-' + p).getAttribute('aria-pressed'),
            'false',
          );
        await id('order-ratio-75').click();
        if (width === 320)
          await page.screenshot({
            path: path.join(out, `quantity-${width}-${fontScale}.png`),
            fullPage: true,
          });
        records.push({ kind: 'quantity-slider', width, fontScale });
      }
    for (const asset of ['BTC', 'BNB', 'PEPE', 'SUI', '币安人生'])
      for (const side of ['buy', 'sell'])
        for (const type of ['market', 'limit']) {
          await open('asset=' + encodeURIComponent(asset));
          await id('inline-order-panel').waitFor();
          if (side === 'sell') await id('asset-detail-sell-button').click();
          if (type === 'limit') {
            await id('order-type-toggle-limit').click();
            await id('order-limit-price-input').fill('100');
          }
          await id('order-quantity-input').fill('1');
          await id('order-execute-submit').click();
          await page.waitForFunction(
            () => window.fixture.state.requests.length === 2,
          );
          const requests = await page.evaluate(
            () => window.fixture.state.requests,
          );
          assert.ok(requests[0].path.endsWith('/quote'));
          assert.equal(requests[1].body.assetId, asset);
          assert.equal(requests[1].body.side, side);
          assert.equal(requests[1].body.orderType ?? 'market', type);
          assert.equal(
            requests[1].body.limitPrice,
            type === 'limit' ? '100' : undefined,
          );
          assert.ok(
            requests[1].body.quoteId && requests[1].body.idempotencyKey,
          );
          records.push({ kind: 'quote-create', asset, side, type });
        }
    for (const asset of ['BTC', 'BNB', 'PEPE', 'SUI', '币安人生']) {
      await open('screen=chart&asset=' + encodeURIComponent(asset));
      await page.locator('#geometry').waitFor({ state: 'attached' });
      const g = await geometry();
      assert.ok(g.minY > 0 && Number.isFinite(g.range));
      assert.ok(await page.locator('svg g[clip-path] g line').count());
      records.push({ kind: 'asset-chart', asset });
    }
    await open('screen=market');
    await page.getByText('币安人生', { exact: true }).first().click();
    await id('asset-pair-header').waitFor();
    assert.match(await id('asset-pair-header').innerText(), /币安人生/);
    records.push({ kind: 'han-market-detail' });
    await open('screen=search');
    await page.getByPlaceholder('종목명 또는 심볼 검색').fill('币安人生');
    await page.getByText('币安人生', { exact: true }).first().click();
    await id('asset-pair-header').waitFor();
    assert.match(await id('asset-pair-header').innerText(), /币安人生 \/ USD/);
    assert.ok(
      (await page.evaluate(() => window.fixture.state.reads)).some((p) =>
        p.includes('%E5%B8%81'),
      ),
      'search query is encoded',
    );
    await id('asset-open-chart').click();
    await id('candlestick-gestures').waitFor();
    assert.ok((await geometry()).range > 0);
    records.push({ kind: 'han-search-detail-chart' });
    await page.setViewportSize({ width: 430, height: 844 });
    const chart = async () => {
      await open('screen=chart&asset=SUI');
      await id('candlestick-gestures').waitFor();
      await page.locator('#geometry').waitFor({ state: 'attached' });
    };
    const reset = async () => {
      const button = page.getByRole('button', {
        name: '차트를 최신 구간으로 초기화',
      });
      if (await button.count()) await button.click();
    };
    const pause = () => page.waitForTimeout(30);
    for (const terminal of [
      'inside',
      'outside',
      'leave',
      'blur',
      'cancel',
      'capture',
      'buttons',
      'visibility',
    ]) {
      await chart();
      const box = await id('candlestick-gestures').boundingBox();
      await page.mouse.move(box.x + 80, box.y + 130);
      await page.mouse.down();
      await page.mouse.move(box.x + 140, box.y + 130);
      await pause();
      assert.ok((await geometry()).startIndex < 180, terminal + ' starts pan');
      if (terminal === 'inside') await page.mouse.up();
      else if (terminal === 'outside') {
        await page.mouse.move(box.x + box.width + 20, box.y + 130);
        await page.mouse.up();
      } else if (terminal === 'blur')
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (terminal === 'visibility')
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            value: 'hidden',
            configurable: true,
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
      else if (terminal === 'buttons')
        await page.evaluate(() =>
          window.dispatchEvent(
            new PointerEvent('pointermove', {
              pointerId: 1,
              buttons: 0,
              clientX: 200,
              clientY: 250,
            }),
          ),
        );
      else
        await id('candlestick-gestures').dispatchEvent(
          terminal === 'cancel'
            ? 'pointercancel'
            : terminal === 'capture'
              ? 'lostpointercapture'
              : 'pointerleave',
          { pointerId: 1, bubbles: true },
        );
      await pause();
      const stopped = (await geometry()).startIndex;
      await page.mouse.move(box.x + 210, box.y + 150);
      await pause();
      assert.equal(
        (await geometry()).startIndex,
        stopped,
        terminal + ' stops dragging',
      );
      await page.mouse.up();
      records.push({ kind: 'pointer-release', terminal });
    }
    await chart();
    let box = await id('candlestick-gestures').boundingBox();
    const before = await geometry();
    const axisX = box.x + before.padding.left + before.innerWidth + 20;
    await page.mouse.move(axisX, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(axisX, box.y + 280);
    await pause();
    await page.mouse.up();
    const expanded = await geometry();
    assert.ok(expanded.range > before.range);
    assert.equal(expanded.startIndex, before.startIndex);
    assert.ok(
      Math.abs(
        expanded.minY + expanded.range / 2 - before.minY - before.range / 2,
      ) < 1e-10,
    );
    const priceLine = page.locator('svg line[stroke-dasharray="3 3"]');
    const lineY = Number(await priceLine.getAttribute('y1'));
    const yFor = (g, price) =>
      g.padding.top + (1 - (price - g.minY) / g.range) * g.innerHeight;
    const renderState = JSON.parse(
      await page.locator('#render-state').textContent(),
    );
    assert.ok(
      Math.abs(lineY - yFor(expanded, renderState.currentPrice)) < 1e-6,
      'current-price line uses scaled geometry',
    );
    const wick = page.locator('svg g[clip-path] g line').first();
    assert.ok(await wick.count(), 'shared candle layer renders');
    const wickY = Number(await wick.getAttribute('y1'));
    assert.ok(
      Math.abs(wickY - yFor(expanded, renderState.firstCandle.high)) < 1e-6,
      'candle uses same scaled geometry',
    );
    // Hover price label is calculated from the same manual range as the candles.
    await page.mouse.move(box.x + 150, box.y + 180);
    await pause();
    const crosshair = page.locator('svg line[stroke-dasharray="2 2"]');
    assert.equal(await crosshair.count(), 2);
    assert.ok(
      Math.abs(Number(await crosshair.nth(1).getAttribute('y1')) - 180) < 1,
    );
    await page.mouse.move(axisX, box.y + 280);
    await page.mouse.down();
    await page.mouse.move(axisX, box.y + 80);
    await pause();
    await page.mouse.up();
    assert.ok((await geometry()).range < expanded.range);
    // Extreme input clamps without moving X or producing an invalid range.
    await page.mouse.move(axisX, box.y + 200);
    await page.mouse.down();
    await page.evaluate(() =>
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          buttons: 1,
          clientX: 400,
          clientY: 1e6,
        }),
      ),
    );
    await pause();
    const clamped = await geometry();
    assert.ok(Number.isFinite(clamped.range) && clamped.minY > 0);
    assert.ok(clamped.range <= before.range * 10.001);
    assert.equal(clamped.startIndex, before.startIndex);
    await page.mouse.up();
    await reset();
    assert.ok(Math.abs((await geometry()).range - before.range) < 1e-10);
    await page.mouse.move(box.x + 100, box.y + 150);
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(160);
    assert.ok((await geometry()).slotWidth > before.slotWidth);
    await page.mouse.wheel(-80, 0);
    await page.waitForTimeout(160);
    assert.ok((await geometry()).startIndex < 180);
    await reset();
    // Replace timeframe while an old pointer is still held. Its cleanup cannot
    // move the new viewport, and the shared latest action restores both axes.
    await page.mouse.move(box.x + 80, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 150);
    await id('asset-timeframe-selector').evaluate((n) => n.click());
    await id('asset-timeframe-option-1h').evaluate((n) => n.click());
    await pause();
    await page.mouse.move(box.x + 210, box.y + 150);
    await page.mouse.up();
    assert.equal((await geometry()).startIndex, 180);
    await id('asset-timeframe-option-1h').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(out, 'chart.png') });
    await page.mouse.move(box.x + 80, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 150);
    await pause();
    assert.ok((await geometry()).startIndex < 180, 'unmount during active pan');
    await page.evaluate(() => window.fixture.setScreen('detail'));
    await pause();
    await page.mouse.up();
    await id('inline-order-panel').waitFor();
    records.push({
      kind: 'chart-y-scale-wheel-reset-timeframe-unmount',
      lineY,
    });
    console.log('BROWSER_SCENARIOS_PASSED', records.length);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify({ records, errors }, null, 2),
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(out, 'failure.json'),
      JSON.stringify({ records, errors, message: error.message }, null, 2),
    );
    await page.screenshot({
      path: path.join(out, 'failure.png'),
      fullPage: true,
    });
    throw error;
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
