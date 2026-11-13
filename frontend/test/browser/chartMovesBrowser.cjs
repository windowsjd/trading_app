// 차트 이동·가격축·십자선(2026-11-13) with a real mouse on the production CandlestickChart (RN-Web),
// through chartPriceLinesFixture.jsx (120 candles, the account's price lines).
// NODE_PATH=<browser-tools>/node_modules BROWSER_EXECUTABLE_PATH=… node test/browser/chartMovesBrowser.cjs
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.CHART_MOVES_OUTPUT ?? '/tmp/trading-chart-moves';
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'chartPriceLinesFixture.jsx')], outfile: path.join(out, 'app.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'chart-moves', setup(b) { b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') })); } }],
    logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/app.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'app.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}</style><div id="root"></div><script src="/app.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/?scenario=spread`);
  await page.getByTestId('candlestick-gestures').waitFor();
  const svg = page.locator('[data-testid="chart-box"] svg').first();
  const area = await page.getByTestId('candlestick-gestures').boundingBox();
  // The plot ends where the price axis begins (the current-price box starts there).
  const state = () => page.evaluate(() => {
    const svgEl = document.querySelector('[data-testid="chart-box"] svg');
    const bodies = [...svgEl.querySelectorAll('g[clip-path] rect')].map(r => ({ x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width') }));
    const dashed = [...svgEl.querySelectorAll('line')].filter(l => l.getAttribute('stroke-dasharray') === '2 2').map(l => ({ x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1') }));
    const lines = [...svgEl.querySelectorAll('line')].filter(l => /^(6|3) (3|4)$/.test(l.getAttribute('stroke-dasharray') ?? '') || l.getAttribute('stroke-dasharray') === '5 3').map(l => +l.getAttribute('y1'));
    const texts = [...svgEl.querySelectorAll('text')].map(t => t.textContent);
    const reset = !!document.querySelector('[aria-label="차트를 최신 구간으로 초기화"]');
    return { bodies, dashed, lines, texts, reset, scroll: document.scrollingElement.scrollWidth - document.documentElement.clientWidth };
  });
  const before = await state();
  assert.ok(before.bodies.length >= 60, `${before.bodies.length} candles drawn`);
  const plotRight = await svg.evaluate(el => Math.max(...[...el.querySelectorAll('line')].map(l => +l.getAttribute('x2'))));
  const cx = area.x + plotRight / 2, cy = area.y + 150;
  const results = [];
  const check = (name, ok, detail = '') => { results.push(`${ok ? 'ok ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!ok) process.exitCode = 1; };

  // Hover follows; leaving clears.
  await page.mouse.move(cx, cy);
  check('hover shows the crosshair', (await state()).dashed.length === 2);
  await page.mouse.move(area.x + area.width / 2, area.y + area.height + 120);
  check('leaving clears a hovering crosshair', (await state()).dashed.length === 0);

  // A click pins; hover elsewhere and leaving keep it; the next click clears it.
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.up();
  const pinned = (await state()).dashed;
  await page.mouse.move(cx - 60, cy + 40);
  check('hover does not move a pinned crosshair', JSON.stringify((await state()).dashed) === JSON.stringify(pinned));
  await page.mouse.move(area.x + area.width / 2, area.y + area.height + 120);
  check('leaving keeps a pinned crosshair', (await state()).dashed.length === 2);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.up();
  check('the next click clears it', (await state()).dashed.length === 0);
  check('a click does not move the chart', JSON.stringify((await state()).bodies) === JSON.stringify(before.bodies));

  // A vertical drag: after the take-over (12 px) candles and price lines follow the finger.
  const drag = async (fromX, fromY, dx, dy, steps = 30) => {
    await page.mouse.move(fromX, fromY); await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(fromX + (dx * i) / steps, fromY + (dy * i) / steps);
    await page.mouse.up();
  };
  await drag(cx, cy, 0, 60);
  const vertical = await state();
  const dyCandle = vertical.bodies[30].y - before.bodies[30].y;
  check('a vertical drag moves the candles down with the mouse', dyCandle > 40 && dyCandle <= 60.5, `${dyCandle.toFixed(1)} px`);
  check('price lines move exactly with the candles', before.lines.length > 0 && before.lines.every((y, i) => Math.abs(vertical.lines[i] - y - dyCandle) < 0.6),
    `${before.lines.length} lines`);
  check('time did not move', Math.abs(vertical.bodies[30].x - before.bodies[30].x) < 0.01);
  // Then sideways: 80 px right = 80 px older, pixel for pixel. A crosshair pinned on a
  // candle rides along with it, so its line measures the move on that very candle.
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.up();
  const anchor = (await state()).dashed;
  await drag(cx + 30, cy + 30, 80, 0, 40);
  const sideways = await state();
  check('a horizontal drag follows the mouse pixel for pixel (the pinned candle moved 80 px)',
    sideways.dashed.length === 2 && Math.abs(sideways.dashed[0].x1 - anchor[0].x1 - 80) < 0.6, `${(sideways.dashed[0]?.x1 - anchor[0].x1).toFixed(2)} px`);
  check('the pinned crosshair keeps its price while the chart moves sideways', Math.abs(sideways.dashed[1].y1 - anchor[1].y1) < 0.6);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.up();
  check('최신 is offered after moving', sideways.reset);
  // The price axis scales; time stays.
  const axisX = area.x + plotRight + 20;
  const topLabel = sideways.texts.find(t => /^\$/.test(t));
  await drag(axisX, cy, 0, 50, 20);
  const scaled = await state();
  check('an axis drag scales prices', scaled.texts.find(t => /^\$/.test(t)) !== topLabel);
  check('an axis drag does not move time', Math.abs(scaled.bodies[10].x - sideways.bodies[10].x) < 0.01);
  // 최신 brings everything back.
  await page.getByLabel('차트를 최신 구간으로 초기화').click();
  const reset = await state();
  check('최신 restores the latest window and the automatic price fit', JSON.stringify(reset.bodies) === JSON.stringify(before.bodies));
  // Wheel zoom is unchanged.
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(200);
  check('wheel zoom still zooms', (await state()).bodies[0].w > before.bodies[0].w);
  check('no sideways page scroll', (await state()).scroll <= 1);
  await page.screenshot({ path: path.join(out, 'chart-after.png') });
  await browser.close(); server.close();
  console.log(results.join('\n'));
  if (errors.length) { console.log(`page errors: ${errors.join(' | ')}`); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exit(1); });
