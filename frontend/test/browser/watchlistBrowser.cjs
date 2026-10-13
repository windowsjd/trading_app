// Real Market/Search screens, rows, stars and watchlist hook on RN Web over a
// scripted local API: add/remove, the watchlist view, its distinct states, and
// star/row geometry at 320-430px, font scale 1/2, light/dark, long names.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.WATCHLIST_BROWSER_OUTPUT ?? '/tmp/trading-watchlist-browser';
const PALETTE = { light: { text: '#202a35', secondary: '#536170' }, dark: { text: '#f2f5f7', secondary: '#c5d0da' } };

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'watchlistFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' }, logLevel: 'warning',
    plugins: [{ name: 'watchlist-boundaries', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /^@react-navigation\/(native|elements)$/ }, () => ({ path: path.join(__dirname, 'watchlistMocks.js') }));
      b.onResolve({ filter: /(services\/api\/client|TradingAccountContext|navigationHooks|constants\/env|storage\/tokenStorage)$/ }, () => ({ path: path.join(__dirname, 'watchlistMocks.js') }));
    } }],
  });
  const server = http.createServer((req, res) => {
    const js = req.url === '/bundle.js';
    res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(js ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let browser; const records = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.BROWSER_CHROMIUM || undefined });
    const context = await browser.newContext();
    // The app defaults to light; "system" lets emulateMedia pick dark.
    await context.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
    const page = await context.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const star = (id) => page.getByTestId(`market-watch-${id}`);
    const fixture = () => page.evaluate(() => JSON.parse(JSON.stringify(window.watchlistFixture.state)));
    const open = async ({ screen = 'market', width = 390, fontScale = 1, appearance = 'light', query = '' } = {}) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?screen=${screen}&fontScale=${fontScale}&${query}`);
    };
    const waitSelected = (id, value) => page.waitForFunction(([testId, expected]) =>
      document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-selected') === expected, [`market-watch-${id}`, String(value)]);
    const rowIds = () => page.$$eval('[data-testid^="market-item-"]', (nodes) => nodes.map((node) => node.dataset.testid.slice('market-item-'.length)));

    // 1. Add from the market list: pending, confirmed, and separate from the detail press.
    await open();
    await waitSelected('KR1', true);
    assert.equal(await star('KR3').getAttribute('aria-selected'), 'false');
    assert.equal(await star('KR3').getAttribute('aria-label'), '국내종목 3 관심종목에 추가');
    await star('KR3').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="market-watch-KR3"]')?.getAttribute('aria-busy') === 'true');
    await waitSelected('KR3', true);
    await page.waitForFunction(() => document.querySelector('[data-testid="market-watch-KR3"]')?.getAttribute('aria-busy') !== 'true');
    let state = await fixture();
    assert.equal(state.requests.filter((request) => request.startsWith('PUT')).length, 1);
    assert.equal(state.navigations.length, 0, 'the star never opens the detail');
    await page.getByTestId('market-item-KR3').click();
    state = await fixture();
    assert.deepEqual(state.navigations, [['AssetDetail', { assetId: 'KR3' }]]);
    assert.equal((await rowIds()).includes('KR-DEEP'), false, 'KR-DEEP is not on the first market page');
    records.push({ flow: 'market-add', passed: true });

    // 2. The watchlist view: server rows of this market, newest first, beyond page one.
    await page.getByTestId('market-scope-watchlist').click();
    await page.getByText('관심종목을 불러오는 중입니다.').waitFor();
    await page.getByTestId('market-item-KR-DEEP').waitFor();
    assert.deepEqual(await rowIds(), ['KR3', 'KR-DEEP', 'KR-OFF', 'KR1']);
    assert.equal(await page.getByTestId('market-sort-control').count(), 0);
    await page.getByText('최근 추가한 순').waitFor();
    await page.getByText('비활성 종목').waitFor();
    // A deactivated item can still be removed.
    await star('KR-OFF').click();
    await page.getByTestId('market-item-KR-OFF').waitFor({ state: 'detached' });
    assert.deepEqual(await rowIds(), ['KR3', 'KR-DEEP', 'KR1']);
    await page.getByTestId('market-tab-us').click();
    await page.getByText('미국 주식 관심종목이 없습니다.').waitFor();
    records.push({ flow: 'watchlist-view', passed: true });

    // 3. Futures never shows the Spot scope or stars.
    await page.getByTestId('market-tab-crypto').click();
    await page.getByTestId('crypto-product-futures').click();
    await page.waitForTimeout(200);
    assert.equal(await page.getByTestId('market-scope').count(), 0);
    assert.equal(await page.locator('[data-testid^="market-watch-"]').count(), 0);
    records.push({ flow: 'futures-excluded', passed: true });

    // 4. A failed read is an error state, never an empty watchlist.
    await open({ query: 'viewFail=1' });
    await waitSelected('KR1', true);
    await page.getByTestId('market-scope-watchlist').click();
    await page.getByText('관심종목을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.').waitFor();
    assert.equal(await page.getByText('국내 주식 관심종목이 없습니다.').count(), 0);
    await open({ query: 'listFail=1' });
    await page.getByText('관심종목 정보를 불러오지 못해 별 표시를 사용할 수 없습니다.').waitFor();
    assert.equal(await star('KR1').getAttribute('aria-disabled'), 'true');
    records.push({ flow: 'error-states', passed: true });

    // 5. A rejected add returns the star to the server state.
    await open({ query: 'fail=limit' });
    await waitSelected('KR1', true);
    await star('KR5').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="market-watch-KR5"]')?.getAttribute('aria-busy') === 'true');
    await page.waitForFunction(() => document.querySelector('[data-testid="market-watch-KR5"]')?.getAttribute('aria-busy') !== 'true');
    assert.equal(await star('KR5').getAttribute('aria-selected'), 'false');
    records.push({ flow: 'failed-add', passed: true });

    // 6. Search results read the same server membership.
    await open({ screen: 'search' });
    await page.getByTestId('market-search-input').fill('KR-DEEP');
    await waitSelected('KR-DEEP', true);
    await star('KR-DEEP').click();
    await waitSelected('KR-DEEP', false);
    state = await fixture();
    assert.equal(state.requests.some((request) => request === 'DELETE /watchlist/KR-DEEP'), true);
    records.push({ flow: 'search-remove', passed: true });

    // 7. Geometry and theme: no clipping, overlap, horizontal scroll or small target.
    for (const appearance of ['light', 'dark']) for (const width of [320, 390, 430]) for (const fontScale of [1, 2]) {
      for (const view of ['market', 'watchlist', 'search']) {
        await open({ screen: view === 'search' ? 'search' : 'market', width, fontScale, appearance, query: 'longName=1&watched=KR1,AAPL,KR-DEEP' });
        if (view === 'search') await page.getByTestId('market-search-input').fill('KR');
        if (view === 'watchlist') await page.getByTestId('market-scope-watchlist').click();
        await page.locator('[data-testid^="market-watch-"]').first().waitFor();
        await waitSelected('KR1', true);
        const failures = await page.evaluate(() => {
          const issues = [];
          const viewport = document.documentElement.clientWidth;
          if (document.documentElement.scrollWidth > viewport + 1) issues.push('horizontal page scroll');
          for (const node of document.querySelectorAll('[data-testid^="market-watch-"]')) {
            const id = node.dataset.testid.slice('market-watch-'.length);
            const target = node.getBoundingClientRect();
            const body = document.querySelector(`[data-testid="market-item-${id}"]`).getBoundingClientRect();
            const card = node.parentElement.getBoundingClientRect();
            if (target.width < 44 || target.height < 44) issues.push(`${id} target ${target.width}x${target.height}`);
            if (target.left < body.right - 0.5 && body.left < target.right - 0.5 && target.top < body.bottom - 0.5 && body.top < target.bottom - 0.5) issues.push(`${id} star overlaps the detail press`);
            if (target.left < card.left - 0.5 || target.right > card.right + 0.5 || card.right > viewport + 0.5) issues.push(`${id} outside its card or the screen`);
            for (const text of node.parentElement.querySelectorAll('[dir="auto"]')) {
              const range = document.createRange(); range.selectNodeContents(text);
              for (const rect of range.getClientRects()) {
                if (rect.width && (rect.left < card.left - 1 || rect.right > card.right + 1 || rect.top < card.top - 1 || rect.bottom > card.bottom + 1))
                  issues.push(`${id} clipped text "${text.textContent}"`);
              }
            }
          }
          for (const text of document.querySelectorAll('[dir="auto"]')) {
            const range = document.createRange(); range.selectNodeContents(text);
            for (const rect of range.getClientRects()) if (rect.width && (rect.left < -1 || rect.right > viewport + 1)) issues.push(`off-screen text "${text.textContent}"`);
          }
          return issues;
        });
        assert.deepEqual(failures, [], `${view} ${appearance} ${width}px x${fontScale}`);
        const colors = await page.evaluate(() => ({
          watched: document.querySelector('[data-testid="market-watch-KR1"] path')?.getAttribute('fill'),
          unwatched: [...document.querySelectorAll('[data-testid^="market-watch-"]')]
            .find((node) => node.getAttribute('aria-selected') === 'false')?.querySelector('path')?.getAttribute('stroke') ?? null,
        }));
        assert.equal(colors.watched?.toLowerCase(), PALETTE[appearance].text, `${appearance} filled star`);
        if (colors.unwatched) assert.equal(colors.unwatched.toLowerCase(), PALETTE[appearance].secondary, `${appearance} outline star`);
        if ((width === 320 && fontScale === 2) || (width === 430 && fontScale === 1))
          await page.screenshot({ path: path.join(out, `${view}-${appearance}-${width}-${fontScale}.png`), fullPage: false });
        records.push({ view, appearance, width, fontScale, geometry: true });
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ records, errors }, null, 2));
    console.log(`PASS: ${records.length} watchlist browser cases; artifacts: ${out}`);
  } finally { await browser?.close(); server.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
