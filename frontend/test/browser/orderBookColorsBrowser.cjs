// Focused RN-Web regression using the existing Spot/Futures production fixtures.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.ORDER_BOOK_BROWSER_OUTPUT ?? '/tmp/trading-order-book-colors';
const expected = {
  light: { text: ['rgb(200, 36, 30)', 'rgb(27, 94, 201)'], surface: ['rgb(254, 242, 242)', 'rgb(239, 246, 255)'] },
  dark: { text: ['rgb(255, 107, 100)', 'rgb(100, 162, 255)'], surface: ['rgb(56, 35, 42)', 'rgb(30, 48, 75)'] },
};

async function main() {
  fs.mkdirSync(out, { recursive: true });
  for (const domain of ['trading', 'futures']) {
    const mock = path.join(__dirname, `${domain}Mocks.js`);
    await esbuild.build({
      entryPoints: [path.join(__dirname, `${domain}Fixture.jsx`)], outfile: path.join(out, `${domain}.js`),
      bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
      resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
      define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', 'process.env.EXPO_PUBLIC_LOGO_DEV_KEY': '""', __DEV__: 'false' },
      loader: { '.png': 'dataurl' }, logLevel: 'warning',
      plugins: [{ name: 'existing-fixtures', setup(b) {
        b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
        b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: mock }));
        b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook|useMarketTickers)$/ }, () => ({ path: mock }));
      } }],
    });
  }
  const server = http.createServer((req, res) => {
    const file = /^\/(trading|futures)\.js$/.test(req.url) ? req.url.slice(1) : null;
    res.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
    res.end(file ? fs.readFileSync(path.join(out, file)) :
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/${req.url.startsWith('/futures') ? 'futures' : 'trading'}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const records = [];
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
    for (const domain of ['trading', 'futures']) for (const appearance of ['light', 'dark'])
      for (const palette of ['red_blue', 'green_red']) for (const fontScale of [1, 2]) {
        const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
        await page.addInitScript(palette => {
          localStorage.setItem('trading-app:appearance', 'system');
          localStorage.setItem('trading-app:financial-colors', palette);
        }, palette);
        await page.emulateMedia({ colorScheme: appearance });
        await page.goto(`${base}/${domain}?screen=order&asset=BNB&viewport=1&kind=open&fontScale=${fontScale}`);
        const ask = page.getByTestId('asset-order-book-asks-1');
        const bid = page.getByTestId('asset-order-book-bids-1');
        await ask.waitFor(); await bid.waitFor();
        for (const [index, row] of [ask, bid].entries()) {
          assert.equal(await row.locator('div').first().evaluate(el => getComputedStyle(el).color), expected[appearance].text[index]);
          assert.equal(await row.evaluate(el => getComputedStyle(el).backgroundColor), expected[appearance].surface[index]);
        }
        const before = [await ask.innerText(), await bid.innerText()];
        await page.evaluate(domain => {
          const theme = domain === 'trading' ? window.tradingAppearance : window.futuresAppearance;
          theme.setFinancialPreference(theme.financialPreference === 'red_blue' ? 'green_red' : 'red_blue');
        }, domain);
        // Wait for React to paint the preference change before comparing the book.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await ask.locator('div').first().evaluate(el => getComputedStyle(el).color), expected[appearance].text[0]);
        assert.equal(await bid.locator('div').first().evaluate(el => getComputedStyle(el).color), expected[appearance].text[1]);
        assert.deepEqual([await ask.innerText(), await bid.innerText()], before);
        assert.deepEqual(errors, []);
        const tag = `${domain}-${appearance}-${palette}-${fontScale}x`;
        await page.getByTestId('asset-order-book').screenshot({ path: path.join(out, `${tag}.png`) });
        records.push(tag);
        await page.close();
      }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ records }, null, 2));
    console.log(`order book colors browser passed (${records.length} layouts)`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
