// US stock names in RN Web (2026-10-18): a listing with a Korean name leads with it and keeps
// `(English) · SYMBOL` under it on the asset detail header, the market search row and the
// holding row, with long Korean and English names, at 320/360/390/430 × light/dark × 1/1.5/2.
// Every name line stays inside its own row and touches no other text (price, badge, values).
// RN-Web only — not a device check. Requires esbuild and Playwright (see README).
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const out = process.env.US_NAME_BROWSER_OUTPUT ?? '/tmp/trading-us-stock-names';
const quick = process.env.US_NAME_QUICK === '1';

/** In page: text inside `root` that leaves it, or two different texts drawn over each other. */
function textProblems(rootId) {
  const root = document.querySelector(`[data-testid="${rootId}"]`);
  if (!root) return [`missing ${rootId}`];
  const box = root.getBoundingClientRect(), words = [], problems = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || node.parentElement.closest('[aria-hidden="true"]')) continue;
    for (const word of node.textContent.matchAll(/\S+/gu)) {
      const range = document.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
      for (const r of range.getClientRects()) words.push({ owner: node.parentElement, text: word[0], r });
    }
  }
  for (const { text, r } of words)
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.right > innerWidth + 0.5) problems.push(`outside: ${text}`);
  for (let i = 0; i < words.length; i += 1) for (let j = i + 1; j < words.length; j += 1) {
    const a = words[i], b = words[j];
    if (a.owner === b.owner) continue;
    const overlapX = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const overlapY = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (overlapX > 1 && overlapY > 1) problems.push(`overlap: ${a.text} / ${b.text}`);
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}`);
  return problems;
}

async function run() {
  fs.mkdirSync(out, { recursive: true });
  const root = path.resolve(__dirname, '../..');
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
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
      b.onResolve({ filter: /CandlestickChartRenderer$/ }, (args) => args.importer.endsWith('rendererProbe.jsx') ? undefined : ({ path: path.join(__dirname, 'rendererProbe.jsx') }));
    } }],
    logLevel: 'warning',
  });
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  const server = http.createServer((req, res) => {
    const js = req.url.startsWith('/bundle.js');
    res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(out, js ? 'bundle.js' : 'index.html')));
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined });
  const base = `http://127.0.0.1:${server.address().port}`;
  const listings = [
    { query: '', korean: '애플', english: '(Apple Inc.) · AAPL' },
    { query: '&usSymbol=BRK.B&usMarket=NYS&usName=Berkshire%20Hathaway%20Inc.%20Class%20B', korean: '버크셔 해서웨이 Class B', english: '(Berkshire Hathaway Inc. Class B) · BRK.B' },
    { query: '&usSymbol=AMD&usName=Advanced%20Micro%20Devices%2C%20Inc.', korean: 'AMD(어드밴스드 마이크로 디바이시스)', english: '(Advanced Micro Devices, Inc.) · AMD' },
  ];
  const report = [];
  try {
    for (const width of quick ? [320] : [320, 360, 390, 430])
      for (const appearance of quick ? ['dark'] : ['light', 'dark'])
        for (const fontScale of quick ? [2] : [1, 1.5, 2]) {
          const tag = `${width}-${appearance}-${fontScale}x`;
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
          await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
          await page.emulateMedia({ colorScheme: appearance });
          const text = (id) => page.getByTestId(id).innerText();
          const check = async (name, rootId) => {
            const problems = await page.evaluate(textProblems, rootId);
            report.push({ shot: `${name}-${tag}`, problems });
            if (width === 320 || width === 430) await page.getByTestId(rootId).screenshot({ path: path.join(out, `${name}-${tag}.png`) });
          };
          // 1. Asset detail header: Korean name, then `(English) · SYMBOL`, then the price.
          for (const [index, listing] of listings.entries()) {
            await page.goto(`${base}/?screen=detail&viewport=1&usOfficial=1&asset=AAPL&fontScale=${fontScale}${listing.query}`);
            await page.getByTestId('asset-detail-name').waitFor();
            assert.equal(await text('asset-detail-name'), listing.korean, `detail name (${tag})`);
            assert.equal(await text('asset-detail-english-name'), listing.english, `detail English line (${tag})`);
            const [nameBox, englishBox, priceBox] = await Promise.all(['asset-name-selector', 'asset-detail-english-name', 'asset-detail-primary-price']
              .map((id) => page.getByTestId(id).boundingBox()));
            assert.ok(englishBox.y >= nameBox.y + nameBox.height - 1 && priceBox.y >= englishBox.y + englishBox.height - 1, `lines in order (${tag})`);
            await page.evaluate(() => {
              const header = document.querySelector('[data-testid="asset-name-selector"]').parentElement.parentElement;
              header.setAttribute('data-testid', 'asset-detail-header-probe');
            });
            await check(`detail-${index}`, 'asset-detail-header-probe');
          }
          // 2. Market search: 애플 finds the listing; its row keeps the English line under the name.
          await page.goto(`${base}/?screen=search&viewport=1&usOfficial=1&fontScale=${fontScale}`);
          await page.getByTestId('market-search-input').fill('애플');
          await page.getByTestId('market-name-AAPL').waitFor();
          assert.equal(await text('market-name-AAPL'), '애플', `search name (${tag})`);
          assert.equal(await text('market-subtitle-AAPL'), '(Apple Inc.) · AAPL', `search English line (${tag})`);
          await check('search', 'market-item-AAPL');
          // 3. Holding row (other holdings under the order form): the same two lines above the quantity.
          await page.goto(`${base}/?screen=order&viewport=1&usOfficial=1&asset=AAPL&stock=1&otherHolding=us&fontScale=${fontScale}`);
          await page.getByTestId('spot-card-MSFT-name').waitFor();
          assert.equal(await text('spot-card-MSFT-name'), '마이크로소프트', `holding name (${tag})`);
          assert.equal(await text('spot-card-MSFT-english-name'), '(Microsoft Corporation) · MSFT', `holding English line (${tag})`);
          await check('holding', 'spot-card-MSFT');
          assert.deepEqual(errors, [], `${tag} page errors`);
          await page.close();
        }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const failing = report.filter((entry) => entry.problems.length);
  assert.deepEqual(failing, [], 'name lines inside their rows, over no other text');
  console.log(`us stock names browser: ${report.length} screens checked, screenshots in ${out}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
