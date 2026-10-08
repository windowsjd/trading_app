// Real Home/Portfolio screens and account scope; only HTTP/navigation are fixtures.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..'), out = process.env.SETTLED_BROWSER_OUTPUT ?? '/tmp/trading-f31-browser';
async function main() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'homeFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')], resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' }, define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, plugins: [{ name: 'fixture-transport', setup(b) {
    b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
    b.onResolve({ filter: /(services\/api\/client|navigationHooks)$/ }, () => ({ path: path.join(__dirname, 'homeMocks.js') }));
  } }], logLevel: 'warning' });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  const server = http.createServer((req, res) => {
    const file = req.url.startsWith('/bundle.js') ? 'bundle.js' : 'index.html';
    res.setHeader('Content-Type', file === 'bundle.js' ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(out, file)));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(), errors = [], layouts = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('selectedTradingAccountId:home-user', 'season-account');
    localStorage.setItem('trading-app:appearance', 'system');
  });
  try {
    for (const width of [320, 360, 390, 430]) for (const mode of ['light', 'dark']) for (const fontScale of [1, 2]) for (const screen of ['home', 'portfolio']) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: mode });
      await page.goto(`${base}/?state=settled&screen=${screen}&fontScale=${fontScale}&long=1`);
      await page.getByText('최종 자산', { exact: true }).waitFor();
      await page.getByText('1,234,567,890,123,456원', { exact: true }).first().waitFor();
      await theme.canvas(page, mode);
      assert.doesNotMatch(await page.locator('#root').textContent(), /Futures 미실현|선물 미실현/);
      if (screen === 'portfolio') await page.getByText('최종 수익률 -3.52%', { exact: true }).waitFor();
      const overflow = await page.evaluate(() => [...document.querySelectorAll('div,span')].flatMap(el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (!r.width || !r.height) return [];
        if (r.left < -1 || r.right > innerWidth + 1) return [{ text: el.textContent.slice(0, 80), reason: 'box' }];
        if (el.childNodes.length !== 1 || el.firstChild.nodeType !== Node.TEXT_NODE) return [];
        return [...el.textContent.matchAll(/\S+/gu)].flatMap(m => {
          const range = document.createRange(); range.setStart(el.firstChild, m.index); range.setEnd(el.firstChild, m.index + m[0].length);
          return [...range.getClientRects()].filter(t => t.left < r.left - 1 || t.right > r.right + 1 || (s.overflow === 'hidden' && (t.top < r.top - 1 || t.bottom > r.bottom + 1))).map(() => ({ text: el.textContent, reason: 'glyph' }));
        });
      }));
      const label = `${screen}-${width}-${mode}-${fontScale}`;
      assert.deepEqual(overflow, [], label);
      layouts.push(label);
      if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ layouts, errors }, null, 2));
    console.log(`Settled Home/Portfolio: ${layouts.length} layouts passed`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
