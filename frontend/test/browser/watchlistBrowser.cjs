// Existing RN Web fixture workflow. esbuild/Playwright are external test tools.
const path = require('node:path'),
  fs = require('node:fs'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const esbuild = require('esbuild'),
  { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.WATCHLIST_BROWSER_OUTPUT ?? '/tmp/trading-watchlist-browser';

async function main() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'watchlistFixture.jsx')],
    outfile: path.join(out, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [
      {
        name: 'watchlist-fixture-boundaries',
        setup(b) {
          b.onResolve({ filter: /^react-native$/ }, () => ({
            path: path.join(__dirname, 'nativeWeb.jsx'),
          }));
          b.onResolve(
            {
              filter:
                /(^@react-navigation\/native$|services\/api\/client$|\/useMarketTickers$|\/useAdminDiagnostics$|\/QuestGuideProvider$|\/useTradingGuideFacts$)/,
            },
            () => ({ path: path.join(__dirname, 'watchlistMocks.js') }),
          );
        },
      },
    ],
  });
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>';
  const server = http
    .createServer((req, res) => {
      const js = req.url.startsWith('/bundle.js');
      res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
      res.end(js ? fs.readFileSync(path.join(out, 'bundle.js')) : html);
    })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  const errors = [],
    results = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(message.text());
    });
    page.on('requestfailed', (req) =>
      console.error(`Request failed: ${req.url()} ${req.failure()?.errorText}`),
    );
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort(),
    );
    for (const appearance of ['light', 'dark'])
      for (const width of [320, 360, 390, 430])
        for (const fontScale of [1, 2]) {
          for (const screen of ['Market', 'MarketSearch', 'Watchlist']) {
            await page.setViewportSize({ width, height: 844 });
            await page.emulateMedia({ colorScheme: appearance });
            await page.goto(`${base}/?screen=${screen}&fontScale=${fontScale}`);
            if (screen === 'MarketSearch')
              await page.getByTestId('market-search-input').fill('LONG');
            await page
              .getByTestId(
                screen === 'Watchlist' ? 'watchlist-button-off-page' : 'watchlist-button-a',
              )
              .waitFor();
            await page.evaluate(
              (value) => window.watchlistAppearance.setPreference(value),
              appearance,
            );
            await page.waitForFunction(
              (value) => document.documentElement.style.colorScheme === value,
              appearance,
            );
            await page.evaluate(() => document.fonts.ready);
            await theme.canvas(page, appearance);
            const clipped = await page.evaluate(() => {
              const failures = [];
              for (const el of document.querySelectorAll('#root *')) {
                if (el.children.length || !el.textContent.trim()) continue;
                const box = el.getBoundingClientRect();
                if (!box.width || !box.height) continue;
                if (
                  box.left < -1 ||
                  box.right > innerWidth + 1 ||
                  el.scrollWidth > el.clientWidth + 1 ||
                  el.scrollHeight > el.clientHeight + 1
                )
                  failures.push({
                    text: el.textContent.slice(0, 45),
                    box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
                    scroll: [el.scrollWidth, el.scrollHeight],
                    client: [el.clientWidth, el.clientHeight],
                  });
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                const range = document.createRange();
                while (walker.nextNode()) {
                  const node = walker.currentNode;
                  for (let index = 0; index < node.textContent.length; index++) {
                    if (/\s/.test(node.textContent[index])) continue;
                    range.setStart(node, index);
                    range.setEnd(node, index + 1);
                    const glyph = range.getBoundingClientRect();
                    if (
                      glyph.left < box.left - 1 ||
                      glyph.right > box.right + 1 ||
                      glyph.top < box.top - 2 ||
                      glyph.bottom > box.bottom + 2
                    ) {
                      failures.push({
                        text: el.textContent.slice(0, 45),
                        glyph: node.textContent[index],
                        bounds: [glyph.left, glyph.top, glyph.right, glyph.bottom],
                        box: [box.left, box.top, box.right, box.bottom],
                      });
                      break;
                    }
                  }
                }
              }
              return failures;
            });
            if (clipped.length)
              await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
            assert.deepEqual(clipped, [], `${screen} ${appearance} ${width}px scale ${fontScale}`);
            const button = page.getByTestId(
              screen === 'Watchlist' ? 'watchlist-button-off-page' : 'watchlist-button-a',
            );
            const bounds = await button.boundingBox();
            assert.equal(bounds.width >= 48 && bounds.height >= 48, true, 'watchlist touch target');
            if (screen === 'Watchlist') {
              await page.getByText('비활성 · 거래 불가', { exact: true }).waitFor();
              assert.equal(await page.getByText('Only US Market', { exact: true }).count(), 0);
            }
            results.push({ screen, appearance, width, fontScale, clipped });
            if (width === 320 && fontScale === 2)
              await page.screenshot({
                path: path.join(out, `${screen}-${appearance}-320-scale2.png`),
                fullPage: true,
              });
          }
          for (const state of ['empty', 'error', 'loading']) {
            await page.goto(`${base}/?screen=Watchlist&state=${state}&fontScale=${fontScale}`);
            await page
              .getByText(
                state === 'empty'
                  ? '등록된 관심종목이 없습니다.'
                  : state === 'error'
                    ? '관심종목을 확인하지 못했습니다. 다시 조회해주세요.'
                    : '관심종목을 확인하는 중입니다.',
                { exact: true },
              )
              .waitFor();
            if (state !== 'empty')
              assert.equal(
                await page.getByText('등록된 관심종목이 없습니다.', { exact: true }).count(),
                0,
              );
            results.push({ screen: 'Watchlist', state, appearance, width, fontScale });
          }
        }
    await page.goto(`${base}/?screen=Market`);
    const star = page.getByTestId('watchlist-button-a');
    await star.waitFor();
    await star.dblclick();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="watchlist-button-a"]')
        .getAttribute('aria-label')
        .endsWith('해제'),
    );
    assert.equal(
      await page.evaluate(
        () => window.watchlistRequests.filter((method) => method === 'PUT').length,
      ),
      1,
    );
    assert.equal(await page.evaluate(() => window.lastNavigation === undefined), true);
    await page.getByText('종목명 또는 심볼 검색', { exact: true }).click();
    await page.getByTestId('market-search-input').fill('LONG');
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="watchlist-button-a"]')
        .getAttribute('aria-label')
        .endsWith('해제'),
    );
    await page.getByTestId('watchlist-button-a').click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="watchlist-button-a"]')
        .getAttribute('aria-label')
        .endsWith('등록'),
    );
    await page.getByTestId('market-item-a').click();
    assert.deepEqual(await page.evaluate(() => window.lastNavigation), [
      'AssetDetail',
      { assetId: 'a' },
    ]);
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(
      path.join(out, 'report.json'),
      JSON.stringify(
        {
          status: 'PASS',
          layouts: results.length,
          interactions: [
            'double touch single PUT',
            'market/search shared state',
            'explicit DELETE',
            'separate detail navigation',
          ],
          results,
        },
        null,
        2,
      ),
    );
    console.log(`watchlist browser PASS (${results.length} layouts + 4 interactions)`);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
