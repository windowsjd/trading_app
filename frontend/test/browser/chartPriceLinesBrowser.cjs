// RN Web check of the account price lines on the production candlestick chart:
// every label fits its box and the plot, no two labels overlap, lines sit at
// their prices (none for an off-range price), the average's return rate (left)
// and its title over its price (right axis) are red in both themes, the axis
// box clears the current price's box and the tick labels, and labels clear the
// 최신 button after a pan. Same external esbuild/Playwright runtime as the other browser
// checks (see README).
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.CHART_LINES_BROWSER_OUTPUT ?? '/tmp/trading-chart-lines-browser';
const RED = { light: '#c8241e', dark: '#ff6b64' };
// Lines drawn and left labels expected per fixture scenario (the average without a rate has none).
const EXPECTED = { spread: [5, 5], crowd: [7, 7], edges: [0, 3], norate: [3, 2], current: [2, 2] };

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
  const results = [], errors = [], fontSizes = [], axisFontSizes = [], axisTitleFontSizes = [];
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const widths = (process.env.CHART_LINES_WIDTHS ?? '320,360,390').split(',').map(Number);
    const fonts = (process.env.CHART_LINES_FONTS ?? '1,2').split(',');
    for (const theme of ['light', 'dark']) for (const width of widths) for (const font of fonts) for (const scenario of Object.keys(EXPECTED)) for (const won of ['0', '1']) {
      const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 2 });
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(mode => localStorage.setItem('trading-app:appearance', mode), theme);
      await page.goto(`${base}/?scenario=${scenario}&won=${won}&fontScale=${font}`);
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
        const rectOf = element => (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(element.getBoundingClientRect());
        const children = (g, tag) => [...g.children].filter(child => child.tagName === tag);
        const boxes = [...svg.querySelectorAll('g')].filter(g => children(g, 'rect').some(rect => colors.has(rect.getAttribute('stroke'))))
          .map(g => {
            // One row per text: a left label has one, the axis box a title over the price.
            const rows = children(g, 'text').map(text => ({ text: text.textContent, fill: text.getAttribute('fill'),
              fontSize: parseFloat(getComputedStyle(text).fontSize), glyph: rectOf(text) }));
            return { text: rows.map(row => row.text).join('\n'), fill: [...new Set(rows.map(row => row.fill))].join(','),
              fontSize: Math.min(...rows.map(row => row.fontSize)), rows, box: rectOf(g.querySelector('rect')), glyph: rows[0].glyph };
          });
        // Grid ticks: a line and its text, no box. The current price: the axis box with no outline.
        const ticks = [...svg.querySelectorAll('g')].filter(g => children(g, 'line').length && children(g, 'text').length && !children(g, 'rect').length)
          .map(g => ({ text: g.querySelector('text').textContent, glyph: rectOf(g.querySelector('text')) }));
        const current = [...svg.querySelectorAll('rect')].filter(rect => !rect.getAttribute('stroke') && Math.abs(rect.getBoundingClientRect().left - plot.right) < 0.5)
          .map(rect => ({ box: rectOf(rect), text: rect.parentNode.querySelector('text').textContent }));
        const chart = document.querySelector('[role="img"]');
        return { plot: { top: plot.top, bottom: plot.bottom, left: plot.left, right: plot.right }, chartRight: frame.right, lines,
          labels: boxes.filter(label => label.box.left < plot.right - 0.5), axis: boxes.filter(label => label.box.left >= plot.right - 0.5),
          ticks, current, spoken: chart?.getAttribute('aria-label') ?? '' };
      });
      const overlaps = (a, b) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5 && a.left < b.right - 0.5 && b.left < a.right - 0.5;
      const check = (state, context, panned = false) => {
        if (!panned) assert.equal(state.labels.length, EXPECTED[scenario][1], `${context}: left labels drawn`);
        for (const label of state.labels) {
          assert.ok(label.box.left >= state.plot.left - 0.5 && label.box.right <= state.plot.right + 0.5, `${context}: ${label.text} leaves the plot sideways`);
          assert.ok(label.box.top >= state.plot.top - 0.5 && label.box.bottom <= state.plot.bottom + 0.5, `${context}: ${label.text} leaves the plot`);
          assert.ok(label.glyph.left >= label.box.left - 0.5 && label.glyph.right <= label.box.right + 0.5, `${context}: ${label.text} text overflows its box (${label.glyph.right - label.box.right})`);
          assert.doesNotMatch(label.text, /P&L|PnL|손익/u, `${context}: no P&L`);
        }
        const sorted = [...state.labels].sort((a, b) => a.box.top - b.box.top);
        for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].box.top >= sorted[i - 1].box.bottom - 0.5, `${context}: ${sorted[i - 1].text} / ${sorted[i].text} overlap`);
        // The average: its signed rate alone at the left (none without one), its price alone on the axis, both red.
        const rates = state.labels.filter(label => /%$/u.test(label.text));
        if (scenario === 'norate') assert.equal(rates.length, 0, `${context}: no made-up rate`);
        else {
          assert.equal(rates.length, 1, `${context}: one rate label`);
          assert.match(rates[0].text, /^([▲▼] )?[+-]\d+(\.\d+)?%$/u, `${context}: signed rate alone`);
          assert.equal(rates[0].fill, RED[theme], `${context}: the rate is red`);
        }
        assert.equal(state.labels.some(label => /평단가|진입가/u.test(label.text)), false, `${context}: no average title at the left`);
        assert.equal(state.axis.length, 1, `${context}: one axis price`);
        const [axis] = state.axis;
        assert.equal(axis.fill, RED[theme], `${context}: the axis title and price are red`);
        assert.match(axis.text, won === '1' ? /^([▲▼] )?(평단가|[롱숏] 진입가)\n[\d,]+원$/u : /^([▲▼] )?(평단가|[롱숏] 진입가)\n\$[\d,]+(\.\d+)?$/u,
          `${context}: the title over the price`);
        assert.ok(axis.box.right <= state.chartRight + 0.5 && axis.box.top >= state.plot.top - 8.5 && axis.box.bottom <= state.plot.bottom + 8.5, `${context}: axis box inside the chart`);
        for (const row of axis.rows) {
          assert.ok(row.glyph.left >= axis.box.left - 0.5 && row.glyph.right <= axis.box.right + 0.5, `${context}: ${row.text} overflows its axis box (${row.glyph.right - axis.box.right})`);
          assert.ok(row.glyph.top >= axis.box.top - 0.5 && row.glyph.bottom <= axis.box.bottom + 0.5, `${context}: ${row.text} leaves its axis box vertically`);
        }
        const [title, price] = axis.rows;
        assert.ok(title.glyph.bottom <= price.glyph.top + 0.5, `${context}: the title sits right over the price (${title.glyph.bottom} / ${price.glyph.top})`);
        // The price row on the average's line, unless the box stepped aside for the current price.
        const averageLine = state.lines.find(line => line.stroke === RED[theme]);
        const stepped = state.current.some(current => Math.abs(axis.box.bottom - current.box.top) < 3 || Math.abs(axis.box.top - current.box.bottom) < 3);
        if (averageLine && !stepped) assert.ok(averageLine.y >= price.glyph.top - 1 && averageLine.y <= price.glyph.bottom + 1, `${context}: the price on its line (${averageLine.y} in ${price.glyph.top}..${price.glyph.bottom})`);
        if (scenario === 'current') assert.equal(stepped, true, `${context}: the axis box steps aside for the current price`);
        for (const current of state.current) assert.ok(axis.box.bottom <= current.box.top + 0.5 || axis.box.top >= current.box.bottom - 0.5, `${context}: axis price over the current price ${current.text}`);
        for (const tick of state.ticks) assert.equal(overlaps(axis.box, tick.glyph), false, `${context}: tick ${tick.text} under the axis price`);
        for (const text of [...state.labels.map(label => label.text), `${title.text} ${price.text}`]) assert.ok(state.spoken.includes(text.replace(/^[▲▼] /u, '')), `${context}: spoken ${text}`);
        fontSizes.push(...state.labels.map(label => label.fontSize)); axisFontSizes.push(price.fontSize); axisTitleFontSizes.push(title.fontSize);
      };
      const context = `${theme}/${width}/${font}x/${scenario}/${won === '1' ? 'won' : 'usd'}`;
      const state = await measure();
      check(state, context);
      assert.equal(state.current.length, 1, `${context}: the current price keeps its axis box`);
      assert.equal(state.lines.length, EXPECTED[scenario][0], `${context}: lines`);
      if (scenario === 'edges') {
        assert.deepEqual(state.labels.map(label => label.text[0]).sort(), ['▲', '▲', '▼'], `${context}: pinned with arrows`);
        assert.equal(state.axis[0].text[0], '▲', `${context}: the axis price pinned with its arrow`);
      } else if (won === '1') {
        assert.equal(state.labels.every(label => /원( · .+)?$|%$/u.test(label.text)), true, `${context}: won labels`);
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
        check(panned, `${context}/panned`, true);
        for (const label of panned.labels) {
          const beside = label.box.left < button.x + button.width && label.box.right > button.x;
          if (beside) assert.ok(label.box.top >= button.y + button.height - 0.5, `${context}: ${label.text} under 최신`);
        }
        await page.screenshot({ path: path.join(out, `${context.replaceAll('/', '-')}-panned.png`) });
      }
      await page.screenshot({ path: path.join(out, `${context.replaceAll('/', '-')}.png`) });
      results.push({ context, labels: state.labels.length, axis: state.axis.map(label => label.text), lines: state.lines.length });
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: results.length, minFontSize: Math.min(...fontSizes), minAxisFontSize: Math.min(...axisFontSizes), minAxisTitleFontSize: Math.min(...axisTitleFontSizes), results }, null, 1));
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
