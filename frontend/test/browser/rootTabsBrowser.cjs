// Cross-tab layout contract using actual RN Web roots and virtualized lists.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.ROOT_TABS_BROWSER_OUTPUT ?? '/tmp/trading-root-tabs-browser';
const screens = {
  home: 'home-account-context', market: 'market-item-asset-0', search: 'market-item-asset-0',
  ranking: 'ranking-item-user-0', record: 'record-season-item-record-0',
  overall: 'overall-My', guide: 'guide-market-basics-card',
};

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'rootTabsFixture.jsx')],
    outfile: path.join(out, 'bundle.js'), bundle: true, minify: true,
    platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'root-tab-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'rootTabsMocks.js') }));
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
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [], records = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('selectedTradingAccountId:home-user', 'season-account');
    localStorage.setItem('trading-app:appearance', 'system');
  });
  const id = (name) => page.getByTestId(name);
  const open = async (screen, query = '') => {
    await page.goto(`${base}/?screen=${screen}${query}`);
    if (screen === 'search') await id('market-search-input').fill('삼성');
    await id(screens[screen]).waitFor();
  };
  try {
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920])
      for (const fontScale of [1, 1.5, 2]) for (const long of [0, 1]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: appearance });
        const bounds = [];
        for (const screen of Object.keys(screens)) {
          await open(screen, `&fontScale=${fontScale}&long=${long}`);
          await theme.canvas(page, appearance);
          const layout = await page.evaluate(({ screen, anchorId }) => {
            const node = (name) => document.querySelector(`[data-testid="${name}"]`);
            const anchor = node(anchorId);
            const box = (el) => {
              const r = el.getBoundingClientRect();
              return { x: r.x, right: r.right, width: r.width };
            };
            let viewport = screen === 'home' ? node('trading-account-season-summary') : anchor.parentElement;
            while (viewport && !/auto|scroll/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
            const sections = [anchor];
            if (screen === 'home') sections.push(node('home-summary-card'), node('home-account-context'));
            if (screen === 'market') sections.push(node('market-tab-domestic').parentElement.parentElement);
            if (screen === 'search') sections.push(node('market-search-input').parentElement);
            if (screen === 'ranking') {
              const label = [...document.querySelectorAll('div')].find((el) => el.textContent === '상위 랭커');
              if (label) sections.push(label.parentElement);
            }
            const clipped = [];
            for (const section of sections.filter(Boolean)) {
              const boundary = section.getBoundingClientRect();
              const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const text = walker.currentNode;
                if (!text.textContent.trim()) continue;
                const range = document.createRange(); range.selectNodeContents(text);
                for (const r of range.getClientRects()) if (r.width && (
                  r.left < boundary.left - 1 || r.right > boundary.right + 1 ||
                  r.top < boundary.top - 1 || r.bottom > boundary.bottom + 1
                )) clipped.push(text.textContent);
              }
            }
            return { content: box(anchor), sections: sections.filter(Boolean).map(box), viewport: viewport && box(viewport), clipped };
          }, { screen, anchorId: screens[screen] });
          const expectedWidth = Math.min(width, 1120) - 32;
          const expectedX = (width - expectedWidth) / 2;
          const context = JSON.stringify({ screen, appearance, width, fontScale, long, layout });
          assert.ok(Math.abs(layout.content.width - expectedWidth) <= 1, context);
          assert.ok(Math.abs(layout.content.x - expectedX) <= 1, context);
          assert.ok(layout.viewport && layout.viewport.x <= 1 && layout.viewport.right >= width - 1, `full screen scroll viewport: ${context}`);
          assert.deepEqual(layout.clipped, [], context);
          for (const section of layout.sections) {
            assert.ok(Math.abs(section.x - expectedX) <= 1 && Math.abs(section.width - expectedWidth) <= 1, context);
          }
          bounds.push(layout.content);
          records.push({ screen, appearance, width, fontScale, long, layout });
          if (!long && fontScale === 1 && [390, 1280, 1920].includes(width)) {
            await page.screenshot({ path: path.join(out, `${screen}-${appearance}-${width}.png`) });
          }
        }
        assert.ok(bounds.every((b) => Math.abs(b.x - bounds[0].x) <= 1 && Math.abs(b.width - bounds[0].width) <= 1), 'all roots share content bounds at the same viewport');
      }

    await page.setViewportSize({ width: 1280, height: 844 });
    for (const [screen, offset] of [['market', 20], ['ranking', 50], ['record', 20]]) {
      await open(screen);
      await id(screens[screen]).evaluate((anchor) => {
        let viewport = anchor.parentElement;
        while (viewport && !/auto|scroll/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
        viewport.scrollTo(0, viewport.scrollHeight);
      });
      await page.waitForFunction((offset) => window.fixture.transport.requests.some((path) => new URL(path, 'https://fixture.invalid').searchParams.get('offset') === String(offset)), offset);
      assert.ok(await page.evaluate(() => window.fixture.client.getQueryCache().getAll().some((query) => query.state.data?.pages?.length >= 2)), `${screen} appends its next page`);
      await id(screens[screen]).click();
      const call = await page.evaluate(() => window.fixture.navigation.calls.at(-1));
      assert.equal(call[0], { market: 'AssetDetail', ranking: 'UserSeasonSummary', record: 'RecordSeasonDetail' }[screen]);
    }
    for (const state of ['active', 'settled']) {
      await open('ranking', `&separateScopes=1&state=${state}`);
      const podium = await id('ranking-top3').textContent();
      for (const scope of ['friends', 'top10', 'all']) {
        await id(`ranking-tab-${scope}`).click();
        await id(scope === 'friends' ? 'ranking-item-user-40' : 'ranking-item-user-0').waitFor();
        assert.equal(await id('ranking-top3').textContent(), podium);
        assert.equal(await id('ranking-top-user-40').count(), 0);
        const request = await page.evaluate(scope => window.fixture.transport.requests.filter(p => p.includes('/ranking?') && new URL(p, location.origin).searchParams.get('scope') === scope).at(-1), scope);
        const params = new URL(request, base).searchParams;
        assert.equal(params.get('rankType'), state === 'settled' ? 'final' : 'daily');
        assert.equal(params.get('capturedAt'), '2026-09-01T00:00:00Z');
        assert.equal(params.get('seasonId'), 'season-1');
      }
    }
    await open('market');
    await page.getByText('종목명 또는 심볼 검색', { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.calls.at(-1)), ['MarketSearch']);
    await open('overall');
    await id('overall-Settings').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.calls.at(-1)), ['Settings']);
    await open('guide');
    await id('guide-market-basics-card').click();
    assert.deepEqual(await page.evaluate(() => window.fixture.navigation.calls.at(-1)), ['MarketBasics']);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ records, crossTabBounds: 'passed', scrollViewports: 'passed', pagination: 'passed', navigation: 'passed', errors }, null, 2));
    for (const name of ['failure.json', 'failure.png']) fs.rmSync(path.join(out, name), { force: true });
    console.log(`ROOT_TABS_BROWSER_PASSED ${records.length} layouts + shared bounds, full screen scroll viewports, pagination and navigation`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ records, errors, message: error.message }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
    throw error;
  } finally { await browser.close(); server.close(); }
}
run().catch((error) => { console.error(error); process.exit(1); });
