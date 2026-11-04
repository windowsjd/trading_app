// RN Web check of the account price lines on the production candlestick chart:
// every label fits its box and the plot, no two labels overlap, lines sit at
// their prices (none for an off-range price), the average is red in both
// themes, and labels clear the 최신 button after a pan. Same external
// esbuild/Playwright runtime as the other browser checks (see README).
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.CHART_LINES_BROWSER_OUTPUT ?? '/tmp/trading-chart-lines-browser';
const RED = { light: '#c8241e', dark: '#ff6b64' };

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'chartPriceLinesFixture.jsx')], outfile: path.join(out, 'app.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'chart-lines', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
    } }],
    logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/app.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'app.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}</style><div id="root"></div><script src="/app.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  const results = [], errors = [];
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const widths = (process.env.CHART_LINES_WIDTHS ?? '320,360,390').split(',').map(Number);
    for (const theme of ['light', 'dark']) for (const width of widths) for (const scenario of ['spread', 'crowd', 'edges']) for (const won of ['0', '1']) {
      const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 2 });
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(mode => localStorage.setItem('trading-app:appearance', mode), theme);
      await page.goto(`${base}/?scenario=${scenario}&won=${won}`);
      await page.locator('svg').first().waitFor();
      const measure = () => page.evaluate(() => {
        const svg = document.querySelector('[data-testid="chart-box"] svg');
        // The plot is the candle clip's rectangle (defs are not laid out: use its attributes).
        const frame = svg.getBoundingClientRect(), clip = svg.querySelector('clipPath rect');
        const attr = name => Number(clip.getAttribute(name));
        const plot = { left: frame.left + attr('x'), top: frame.top + attr('y'), right: frame.left + attr('x') + attr('width'), bottom: frame.top + attr('y') + attr('height') };
        const colors = new Set(['#c8241e', '#ff6b64', '#1b5ec9', '#64a2ff', '#7a3fc4', '#c3a1ff']);
        const lines = [...svg.querySelectorAll('line')].filter(line => colors.has(line.getAttribute('stroke')))
          .map(line => ({ y: line.getBoundingClientRect().top, stroke: line.getAttribute('stroke') }));
        const labels = [...svg.querySelectorAll('g')].filter(g => [...g.children].some(child => child.tagName === 'rect' && colors.has(child.getAttribute('stroke'))))
          .map(g => {
            const box = g.querySelector('rect').getBoundingClientRect(), text = g.querySelector('text');
            return { text: text.textContent, fill: text.getAttribute('fill'), box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
              glyph: (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(text.getBoundingClientRect()) };
          });
        const chart = document.querySelector('[role="img"]');
        return { plot: { top: plot.top, bottom: plot.bottom, left: plot.left, right: plot.right }, lines, labels, spoken: chart?.getAttribute('aria-label') ?? '' };
      });
      const check = (state, context) => {
        assert.ok(state.labels.length >= 3, `${context}: labels drawn`);
        for (const label of state.labels) {
          assert.ok(label.box.left >= state.plot.left - 0.5 && label.box.right <= state.plot.right + 0.5, `${context}: ${label.text} leaves the plot sideways`);
          assert.ok(label.box.top >= state.plot.top - 0.5 && label.box.bottom <= state.plot.bottom + 0.5, `${context}: ${label.text} leaves the plot`);
          assert.ok(label.glyph.left >= label.box.left - 0.5 && label.glyph.right <= label.box.right + 0.5, `${context}: ${label.text} text overflows its box (${label.glyph.right - label.box.right})`);
          assert.doesNotMatch(label.text, /P&L|PnL|손익/u, `${context}: no P&L`);
        }
        const sorted = [...state.labels].sort((a, b) => a.box.top - b.box.top);
        for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].box.top >= sorted[i - 1].box.bottom - 0.5, `${context}: ${sorted[i - 1].text} / ${sorted[i].text} overlap`);
        const average = state.labels.find(label => /평단가|진입가/u.test(label.text));
        assert.equal(average.fill, RED[theme], `${context}: the average and its rate are red`);
        assert.match(average.text, /[+-]\d+(\.\d+)?%$/u, `${context}: signed return rate`);
        for (const label of state.labels) assert.ok(state.spoken.includes(label.text.replace(/^[▲▼] /u, '')), `${context}: spoken ${label.text}`);
      };
      const context = `${theme}/${width}/${scenario}/${won === '1' ? 'won' : 'usd'}`;
      const state = await measure();
      check(state, context);
      if (scenario === 'edges') {
        assert.equal(state.lines.length, 0, `${context}: no line for off-range prices`);
        assert.deepEqual(state.labels.map(label => label.text[0]).sort(), ['▲', '▲', '▼'], `${context}: pinned with arrows`);
      } else {
        assert.equal(state.lines.length, state.labels.length, `${context}: one line per label`);
        if (won === '1') assert.equal(state.labels.every(label => /원( · .+)?$/u.test(label.text)), true, `${context}: won labels`);
      }
      // A pan shows 최신: labels start below it; the lines move with the view.
      if (scenario === 'spread' && won === '0') {
        const plot = state.plot;
        await page.mouse.move(plot.left + 60, plot.top + 120);
        await page.mouse.down();
        await page.mouse.move(plot.left + 200, plot.top + 125, { steps: 8 });
        await page.mouse.up();
        const reset = page.getByRole('button', { name: '차트를 최신 구간으로 초기화' });
        await reset.waitFor();
        const button = await reset.boundingBox();
        const panned = await measure();
        check(panned, `${context}/panned`);
        for (const label of panned.labels) {
          const beside = label.box.left < button.x + button.width && label.box.right > button.x;
          if (beside) assert.ok(label.box.top >= button.y + button.height - 0.5, `${context}: ${label.text} under 최신`);
        }
        await page.screenshot({ path: path.join(out, `${context.replaceAll('/', '-')}-panned.png`) });
      }
      await page.screenshot({ path: path.join(out, `${context.replaceAll('/', '-')}.png`) });
      results.push({ context, labels: state.labels.length, lines: state.lines.length });
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: results.length, results }, null, 1));
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
