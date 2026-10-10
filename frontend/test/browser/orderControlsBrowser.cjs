// Optional real RN Web check for the order screen's buy/sell segment, market/limit
// dropdown and asset sheet. Requires external esbuild and Playwright (see README).
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.ORDER_CONTROLS_BROWSER_OUTPUT ?? '/tmp/trading-order-controls-browser';
// Default red_blue preference: BUY red, SELL blue (financial.buyAction/sellAction).
const ACTION = { buy: 'rgb(209, 17, 11)', sell: 'rgb(10, 90, 194)' };
const WHITE = 'rgb(255, 255, 255)';

async function build() {
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
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
      b.onResolve({ filter: /CandlestickChartRenderer$/ }, (args) => args.importer.endsWith('rendererProbe.jsx') ? undefined : ({ path: path.join(__dirname, 'rendererProbe.jsx') }));
    } }],
    logLevel: 'warning',
  });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
}

// Runs in the page: geometry, visible label colors and text that leaves its box.
function probe() {
  const el = (id) => document.querySelector(`[data-testid="${id}"]`);
  const box = (node) => {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  };
  const opacity = (node, stop) => {
    let value = 1;
    for (let current = node; current && current !== stop; current = current.parentElement) value *= Number(getComputedStyle(current).opacity);
    return value;
  };
  const visibleLabels = (id) => {
    const host = el(id);
    return [...host.querySelectorAll('[dir="auto"]')].filter((t) => opacity(t, host) > 0.99)
      .map((t) => ({ text: t.textContent, color: getComputedStyle(t).color }));
  };
  const clipped = (node, bounds = node.getBoundingClientRect()) => {
    const failures = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      if (!text.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const r of range.getClientRects()) {
        if (r.width && (r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1
          || r.left < -1 || r.right > innerWidth + 1)) failures.push(text.textContent);
      }
    }
    return failures;
  };
  const thumb = el('order-side-thumb-buy')?.parentElement?.parentElement ?? null;
  const triangle = el('order-type-select-triangle');
  const unresolved = [...document.querySelectorAll('body *')].flatMap((node) => {
    const css = getComputedStyle(node);
    return [css.color, css.backgroundColor, css.borderColor, css.fill, css.stroke].filter((value) => /^rgb\((14|15), 0,/.test(value));
  });
  return {
    viewport: { w: innerWidth, h: innerHeight },
    panel: box(el('inline-order-panel')),
    segment: box(el('order-side-segment')),
    buy: box(el('asset-detail-buy-button')),
    sell: box(el('asset-detail-sell-button')),
    thumb: box(thumb),
    thumbColors: {
      buy: el('order-side-thumb-buy') && getComputedStyle(el('order-side-thumb-buy')).backgroundColor,
      sell: el('order-side-thumb-sell') && getComputedStyle(el('order-side-thumb-sell')).backgroundColor,
      buyOpacity: el('order-side-thumb-buy') && Number(getComputedStyle(el('order-side-thumb-buy').parentElement).opacity),
      sellOpacity: el('order-side-thumb-sell') && Number(getComputedStyle(el('order-side-thumb-sell').parentElement).opacity),
    },
    labels: el('asset-detail-buy-button') ? { buy: visibleLabels('asset-detail-buy-button'), sell: visibleLabels('asset-detail-sell-button') } : null,
    // CTAButton paints its surface inside the pressable target.
    submit: el('order-execute-submit') && {
      color: [el('order-execute-submit'), ...el('order-execute-submit').querySelectorAll('*')]
        .map((node) => getComputedStyle(node).backgroundColor).find((color) => color !== 'rgba(0, 0, 0, 0)') ?? null,
      text: el('order-execute-submit').textContent,
    },
    trigger: box(el('order-type-select')),
    surface: box(triangle?.parentElement),
    surfaceText: triangle?.parentElement.textContent ?? null,
    limitInput: box(el('order-limit-price-input')),
    menu: box(el('order-type-menu')),
    menuItems: [el('order-type-toggle-market'), el('order-type-toggle-limit')].filter(Boolean).map((node) => ({ ...box(node), text: node.textContent, selected: node.getAttribute('aria-selected') })),
    sheet: box(el('order-asset-sheet')),
    sheetBackground: el('order-asset-sheet') && getComputedStyle(el('order-asset-sheet')).backgroundColor,
    rows: [...document.querySelectorAll('[data-testid^="market-item-"]')].map((node) => ({ id: node.dataset.testid, ...box(node), clipped: clipped(node) })),
    clipped: {
      segment: el('order-side-segment') ? clipped(el('order-side-segment')) : [],
      trigger: el('order-type-select') ? clipped(el('order-type-select')) : [],
      menu: el('order-type-menu') ? clipped(el('order-type-menu')) : [],
      sheetHeader: el('order-asset-sheet') ? clipped(el('order-asset-sheet').firstElementChild) : [],
    },
    quantity: el('order-quantity-input')?.value ?? null,
    pair: el('asset-change-pair')?.textContent ?? null,
    unresolved,
  };
}

async function run() {
  await build();
  const server = http.createServer((req, res) => {
    const js = req.url.startsWith('/bundle.js');
    res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(out, js ? 'bundle.js' : 'index.html')));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.ORDER_CONTROLS_CHROMIUM ? { executablePath: process.env.ORDER_CONTROLS_CHROMIUM } : {}) });
  const page = await browser.newPage();
  // Follow the emulated color scheme; keep the default red_blue action colors.
  await page.addInitScript(() => {
    localStorage.setItem('trading-app:appearance', 'system');
    localStorage.setItem('trading-app:financial-colors', 'red_blue');
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const id = (value) => page.getByTestId(value);
  const read = () => page.evaluate(probe);
  const settle = () => page.waitForTimeout(450);
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const inside = (point, b) => point.x >= b.x - 1 && point.x <= b.right + 1 && point.y >= b.y - 1 && point.y <= b.bottom + 1;
  const records = [];
  try {
    for (const reducedMotion of ['no-preference', 'reduce'])
      for (const appearance of ['light', 'dark'])
        for (const width of reducedMotion === 'reduce' ? [360] : [320, 360, 390, 430])
          for (const fontScale of reducedMotion === 'reduce' ? [1] : [1, 2]) {
            const label = `${reducedMotion}/${appearance}/${width}/x${fontScale}`;
            const height = 780;
            await page.setViewportSize({ width, height });
            await page.emulateMedia({ colorScheme: appearance, reducedMotion });
            await page.goto(`${base}/?screen=order&asset=SUI&longName=1&fontScale=${fontScale}`);
            await id('order-side-segment').waitFor();
            await page.waitForTimeout(100);
            assert.equal(await page.evaluate(() => window.tradingAppearance.mode), appearance, `${label}: appearance`);

            // A. Buy/sell: one track, equal halves, no gap, BUY color on the thumb.
            let s = await read();
            assert.ok(Math.abs(s.segment.w - s.panel.w) <= 1, `${label}: segment spans the order panel`);
            assert.ok(Math.abs(s.buy.w - s.sell.w) <= 1 && Math.abs(s.sell.x - s.buy.right) <= 1, `${label}: halves meet without a gap`);
            assert.ok(s.buy.h >= 44 && s.sell.h >= 44, `${label}: 44px targets`);
            assert.ok(inside(center(s.thumb), s.buy), `${label}: thumb on BUY`);
            assert.deepEqual([s.thumbColors.buy, s.thumbColors.sell], [ACTION.buy, ACTION.sell], `${label}: existing action colors`);
            assert.equal(s.submit.color, ACTION.buy, `${label}: CTA keeps BUY`);
            assert.deepEqual(s.labels.buy.map((l) => l.color), [WHITE]);
            assert.deepEqual(s.labels.sell.map((l) => l.color), [theme.palettes[appearance].secondary]);
            assert.deepEqual(s.clipped.segment, [], `${label}: segment labels`);
            assert.deepEqual(s.unresolved, [], `${label}: theme tokens resolved`);
            await id('order-quantity-input').fill('1');
            await id('asset-detail-sell-button').click();
            if (reducedMotion === 'reduce') {
              // One frame later the thumb is already in place; a 200ms run would be ~30% along.
              await page.waitForTimeout(32);
              s = await read();
              assert.ok(inside(center(s.thumb), s.sell), `${label}: Reduced Motion lands at once`);
            } else {
              await page.waitForTimeout(40);
              s = await read();
              const moving = center(s.thumb).x;
              assert.ok(moving > s.buy.x + s.buy.w / 2 + 1 && moving < s.sell.x + s.sell.w / 2 - 1, `${label}: thumb moves between halves (${moving})`);
              await settle();
              s = await read();
            }
            assert.ok(inside(center(s.thumb), s.sell), `${label}: thumb on SELL`);
            assert.equal(s.thumbColors.sellOpacity, 1);
            assert.equal(s.submit.color, ACTION.sell);
            assert.equal(s.submit.text, '매도');
            assert.equal(s.quantity, '', `${label}: side change starts a clean form`);
            assert.deepEqual(s.labels.sell.map((l) => l.color), [WHITE]);

            // D. Market/limit: one full-width button, ~2/3 height, 44px target.
            assert.ok(Math.abs(s.trigger.w - s.panel.w) <= 1, `${label}: dropdown spans the former tab pair`);
            assert.ok(s.trigger.h >= 44, `${label}: 44px touch band`);
            if (fontScale === 1) assert.ok(Math.abs(s.surface.h - 30) <= 1, `${label}: visual height ${s.surface.h}`);
            assert.ok(s.trigger.y >= s.segment.bottom - 0.5, `${label}: touch band clears the segment`);
            assert.equal(s.surfaceText, '시장가');
            assert.deepEqual(s.clipped.trigger, []);
            for (const point of [{ x: 6, y: s.trigger.h / 2 }, { x: s.trigger.w - 6, y: s.trigger.h / 2 }, { x: s.trigger.w / 2, y: 2 }]) {
              await id('order-type-select').click({ position: point });
              await id('order-type-menu').waitFor();
              await page.waitForTimeout(reducedMotion === 'reduce' ? 50 : 350);
              const m = await read();
              assert.ok(m.menu.x >= 0 && m.menu.right <= width && m.menu.y >= 0 && m.menu.bottom <= height, `${label}: menu onscreen`);
              assert.ok(m.menu.y >= m.surface.bottom - 0.5, `${label}: menu opens under the button`);
              assert.ok(m.menuItems.every((item) => item.h >= 44), `${label}: menu targets`);
              assert.deepEqual(m.menuItems.map((item) => [item.text, item.selected]), [['시장가✓', 'true'], ['지정가', 'false']]);
              assert.deepEqual(m.clipped.menu, []);
              if (point.y === 2) await page.keyboard.press('Escape');
              else await page.mouse.click(2, height - 2);
              await id('order-type-menu').waitFor({ state: 'detached' });
            }
            await id('order-type-select').click();
            await id('order-type-toggle-limit').click();
            await id('order-limit-price-input').waitFor();
            s = await read();
            assert.equal(s.surfaceText, '지정가');
            assert.ok(s.trigger.bottom <= s.limitInput.y + 0.5, `${label}: touch band clears the limit input`);
            if (fontScale === 1 && reducedMotion !== 'reduce') {
              await id('order-type-select').click(); await page.waitForTimeout(350);
              await page.screenshot({ path: path.join(out, `menu-${appearance}-${width}.png`) });
              await page.keyboard.press('Escape'); await id('order-type-menu').waitFor({ state: 'detached' });
            }

            // C. Asset sheet over the order screen.
            await id('order-quantity-input').fill('2');
            await id('asset-change-pair').click();
            await id('order-asset-sheet').waitFor();
            if (reducedMotion === 'reduce') {
              await page.waitForTimeout(32);
              s = await read();
              assert.ok(Math.abs(s.sheet.bottom - height) <= 1, `${label}: Reduced Motion shows the sheet in place`);
            } else {
              await page.waitForTimeout(40);
              s = await read();
              assert.ok(s.sheet.bottom > height + 20, `${label}: sheet rises from below`);
              await settle();
            }
            await id(`market-item-BTC`).waitFor();
            s = await read();
            assert.ok(s.sheet.x <= 0.5 && Math.abs(s.sheet.w - width) <= 1 && s.sheet.y >= 0 && Math.abs(s.sheet.bottom - height) <= 1, `${label}: sheet frame`);
            assert.ok(s.sheet.y < height * 0.1, `${label}: sheet uses most of the screen`);
            assert.equal(s.sheetBackground, theme.palettes[appearance].surface);
            assert.equal(s.rows.length, 5, `${label}: rows without a search text`);
            assert.ok(s.rows.every((row) => row.x >= s.sheet.x - 1 && row.right <= s.sheet.right + 1 && !row.clipped.length), `${label}: rows ${JSON.stringify(s.rows.filter((row) => row.clipped.length))}`);
            assert.deepEqual(s.clipped.sheetHeader, []);
            assert.equal(s.quantity, '2', `${label}: the order screen stays behind the sheet`);
            assert.deepEqual(s.unresolved, [], `${label}: sheet theme tokens resolved`);
            if (fontScale === 1 && reducedMotion !== 'reduce') await page.screenshot({ path: path.join(out, `sheet-${appearance}-${width}.png`) });
            await id('order-asset-search-input').fill('BTC');
            await page.waitForFunction(() => document.querySelectorAll('[data-testid^="market-item-"]').length === 1);
            await id('order-asset-search-input').fill('');
            await page.waitForFunction(() => document.querySelectorAll('[data-testid^="market-item-"]').length === 5);
            await page.keyboard.press('Escape');
            await id('order-asset-sheet').waitFor({ state: 'detached' });
            s = await read();
            assert.equal(s.quantity, '2', `${label}: closing keeps the inputs`);
            assert.equal(s.surfaceText, '지정가');
            await id('asset-change-pair').click();
            await id('order-asset-sheet-close').click();
            await id('order-asset-sheet').waitFor({ state: 'detached' });
            await id('asset-change-pair').click();
            await id('market-item-BTC').click();
            await page.waitForFunction(() => document.querySelector('[data-testid="asset-change-pair"]')?.textContent.startsWith('BTC'));
            await id('order-side-segment').waitFor();
            await page.waitForTimeout(100);
            s = await read();
            const calls = await page.evaluate(() => window.fixture.state.paramCalls);
            assert.deepEqual(calls.at(-1), { assetId: 'BTC', side: 'sell' }, `${label}: asset and side only`);
            assert.equal(await page.evaluate(() => window.fixture.state.accountId), 'account-fixture');
            assert.ok(inside(center(s.thumb), s.sell), `${label}: side kept`);
            assert.equal(s.quantity, '', `${label}: new asset starts clean`);
            assert.equal(s.surfaceText, '시장가', `${label}: new asset starts at 시장가`);
            assert.equal(s.sheet, null);
            records.push({ label, segment: s.segment, trigger: s.trigger });
            console.log(`ok ${label}`);
          }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(records, null, 2));
    console.log(`ORDER_CONTROLS_BROWSER_OK ${records.length} layouts → ${out}`);
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
