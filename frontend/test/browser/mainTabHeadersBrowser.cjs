// Real navigators/headers/icons, read-only fixture transport, no external calls.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.MAIN_TAB_HEADERS_OUTPUT ?? '/tmp/trading-main-tab-headers';
const quick = process.env.MAIN_TAB_HEADERS_QUICK === '1';

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'mainTabHeadersFixture.jsx')], outfile: path.join(out, 'headers.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'header-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'mainTabHeadersNativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook)$/ }, () => ({ path: path.join(__dirname, 'motionMocks.js') }));
      b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/headers.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'headers.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/headers.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], headers = [], regressions = [];
  const base = `http://127.0.0.1:${server.address().port}`;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const params = new URLSearchParams(location.search);
    localStorage.setItem('selectedTradingAccountId:home-user', `${params.get('account') ?? 'general'}-account`);
    localStorage.setItem('trading-app:appearance', 'system');
  });
  const heading = label => page.getByRole('heading', { name: label, exact: true });
  const bottomTabs = () => page.getByRole('tablist');
  const tab = label => bottomTabs().getByRole('tab', { name: label, exact: true });
  const backButton = () => page.getByLabel(/back|뒤로/i).filter({ visible: true }).first();
  const go = async (tabName, screen, params) => {
    await page.evaluate(({ tabName, screen, params }) => window.fixture.navigationRef.navigate(tabName, { screen, params }), { tabName, screen, params });
  };
  const checkHeader = async (label, context) => {
    await heading(label).waitFor();
    await page.waitForFunction(label => {
      const heading = [...document.querySelectorAll('[role="heading"]')].find(el => el.textContent === label && el.checkVisibility());
      if (!heading) return false;
      for (let el = heading; el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) < 0.999) return false;
      return true;
    }, label);
    const observed = await heading(label).evaluate(el => {
      const rect = el.getBoundingClientRect(), row = el.parentElement, icon = row.querySelector('svg');
      const box = value => { const r = value.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const range = document.createRange(); range.selectNodeContents(el);
      const text = [...range.getClientRects()].map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom }));
      const iconRect = icon.getBoundingClientRect();
      const clipping = [];
      for (let parent = row; parent; parent = parent.parentElement) {
        const s = getComputedStyle(parent), r = parent.getBoundingClientRect();
        if (/hidden|clip/.test(`${s.overflowX} ${s.overflowY}`) &&
          (rect.left < r.left - 1 || rect.right > r.right + 1 || rect.top < r.top - 1 || rect.bottom > r.bottom + 1 ||
           iconRect.left < r.left - 1 || iconRect.right > r.right + 1 || iconRect.top < r.top - 1 || iconRect.bottom > r.bottom + 1)) clipping.push(parent.tagName);
      }
      return {
        weight: getComputedStyle(el).fontWeight, fontSize: parseFloat(getComputedStyle(el).fontSize), color: getComputedStyle(el).color,
        row: box(row), title: box(el), icon: icon && box(icon), text, clipping,
        paths: icon && [...icon.querySelectorAll('path')].map(p => p.getAttribute('d')), stroke: icon?.getAttribute('stroke'),
        artBounds: [...icon.querySelectorAll('path,circle')].map(shape => {
          const r = shape.getBBox(), style = getComputedStyle(shape), half = style.stroke === 'none' ? 0 : parseFloat(style.strokeWidth) / 2;
          return { left: r.x - half, top: r.y - half, right: r.x + r.width + half, bottom: r.y + r.height + half };
        }),
        hidden: icon?.getAttribute('aria-hidden'), accessibleIcon: icon?.closest('[aria-hidden="true"]') != null,
      };
    });
    assert.equal(observed.weight, '700');
    assert.equal(observed.fontSize, 18 * Math.min(context.fontScale, 2), 'audit must scale Animated.Text');
    assert.equal(observed.icon.width, 20); assert.equal(observed.icon.height, 20);
    assert.ok(observed.artBounds.every(r => r.left >= 0 && r.top >= 0 && r.right <= 24 && r.bottom <= 24), 'SVG strokes stay inside the viewBox');
    assert.ok(Math.abs(observed.icon.y + 10 - (observed.title.y + observed.title.height / 2)) < 1, 'vertical centers');
    assert.ok(Math.abs(observed.title.x - observed.icon.right - 6) < 1, 'compact spacing');
    assert.deepEqual(observed.clipping, [], JSON.stringify({ context, label, observed }));
    for (const r of observed.text) assert.ok(r.x >= observed.title.x - 1 && r.right <= observed.title.right + 1 && r.y >= observed.title.y - 1 && r.bottom <= observed.title.bottom + 1, 'complete Korean glyph bounds');
    assert.ok(observed.row.x >= 0 && observed.row.right <= context.width, 'title stays within screen');
    assert.ok(observed.row.y >= context.topInset, 'title stays below safe area');
    assert.equal(observed.color, context.appearance === 'light' ? 'rgb(32, 42, 53)' : 'rgb(242, 245, 247)');
    assert.equal(observed.stroke, context.appearance === 'dark' ? '#f2f5f7' : label === '홈' ? '#111111' : '#202a35');
    assert.equal(observed.hidden, 'true'); assert.equal(observed.accessibleIcon, true);
    assert.equal(await heading(label).count(), 1);
    const bottom = await tab(label).evaluate(el => [...el.querySelectorAll('svg')].map(svg => ({
      paths: [...svg.querySelectorAll('path')].map(p => p.getAttribute('d')),
      fill: svg.getAttribute('fill'), stroke: svg.getAttribute('stroke'), hidden: svg.getAttribute('aria-hidden'),
    })));
    assert.ok(bottom.some(icon => JSON.stringify(icon.paths) === JSON.stringify(observed.paths)), 'header shares the inactive tab geometry');
    assert.ok(bottom.some(icon => icon.fill === '#326FE5'), 'brand active tint');
    assert.equal(await tab(label).getAttribute('aria-selected'), 'true');
    assert.ok(bottom.every(icon => icon.hidden === 'true'));
    headers.push({ ...context, label, observed });
  };
  try {
    for (const appearance of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?icons=1`);
      await page.locator('svg').first().waitFor();
      await page.screenshot({ path: path.join(out, `home-icons-${appearance}.png`) });
    }
    for (const account of ['general', 'season']) for (const appearance of ['light', 'dark'])
      for (const width of quick ? [320] : [320, 360, 390, 430]) for (const fontScale of quick ? [1, 2] : [1, 1.5, 2, 3]) {
      const topInset = width === 390 ? 24 : 0, bottomInset = width === 390 ? 34 : 0;
      const context = { account, appearance, width, fontScale, topInset, bottomInset };
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: appearance, reducedMotion: 'no-preference' });
      await page.goto(`${base}/?account=${account}&fontScale=${fontScale}&topInset=${topInset}&bottomInset=${bottomInset}&navigation=1`);
      await heading('홈').waitFor();
      const labels = account === 'general' ? ['홈', '마켓', '가이드', '지갑', '전체'] : ['홈', '마켓', '랭킹', '지갑', '전체'];
      assert.deepEqual(await bottomTabs().getByRole('tab').allTextContents(), labels);
      for (const label of labels) {
        await tab(label).click();
        await checkHeader(label, context);
        if (width === 320 && [1, 2].includes(fontScale)) await page.screenshot({ path: path.join(out, `${account}-${appearance}-${label}-scale-${fontScale}.png`) });
      }
      const inactiveHome = await tab('홈').evaluate(el => [...el.querySelectorAll('svg')].find(svg => svg.getAttribute('fill') === 'none')?.getAttribute('stroke'));
      assert.equal(inactiveHome, appearance === 'light' ? '#111111' : '#9aa8b6');
      if (width === 320 && fontScale === 2) {
        const details = [
          ['HomeTab', 'Portfolio', '포트폴리오'], ['MarketTab', 'MarketSearch', '종목 검색'],
          ...(account === 'general' ? [['GuideTab', 'MarketBasics', '시장기초'], ['GuideTab', 'Candles', '캔들']] : [['RankingTab', 'UserSeasonSummary', '유저 시즌 요약', { userId: 'user-0', seasonId: 'record-0' }]]),
          ['WalletTab', 'WalletFx', '환전'], ['WalletTab', 'WalletTransactions', '지갑 원장'],
          ['MyTab', 'Settings', '설정'], ['MyTab', 'Friends', '친구'], ['MyTab', 'Notices', '공지사항'],
          ['MyTab', 'My', 'MY'], ['MyTab', 'Reward', '보상 / 뱃지'],
        ];
        for (const [tabName, screen, label, params] of details) {
          const rootLabel = { HomeTab: '홈', MarketTab: '마켓', GuideTab: '가이드', RankingTab: '랭킹', WalletTab: '지갑', MyTab: '전체' }[tabName];
          await tab(rootLabel).click();
          await go(tabName, screen, params); await heading(label).waitFor();
          assert.equal(await heading(label).evaluate(el => el.parentElement.querySelectorAll('svg').length), 0, `${label}: detail stays text-only`);
          await backButton().click(); await heading(rootLabel).waitFor();
          regressions.push({ account, appearance, screen, back: true, rootRestored: true });
        }
        await tab('마켓').click();
        await page.getByTestId('market-item-asset-0').click();
        await page.getByTestId('asset-order-actions').waitFor();
        assert.equal(await bottomTabs().getByRole('tab').count(), 0, 'AssetDetail hides tabs');
        assert.equal(await page.getByRole('heading').filter({ visible: true }).evaluateAll(nodes => nodes.every(el => !el.parentElement.querySelector('svg'))), true);
        await backButton().click();
        await heading('마켓').waitFor(); assert.equal(await bottomTabs().getByRole('tab').count(), 5);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await tab('홈').click(); await checkHeader('홈', context);
        await go('HomeTab', 'Portfolio'); await heading('포트폴리오').waitFor();
        await backButton().click();
        await heading('홈').waitFor();
        regressions.push({ account, appearance, screen: 'AssetDetail', tabsHiddenAndRestored: true, reducedMotion: true });
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ headers, regressions, errors }, null, 2));
    console.log(JSON.stringify({ headerChecks: headers.length, regressionFlows: regressions.length, errors, out }));
  } finally {
    await page.screenshot({ path: path.join(out, 'last-screen.png') }).catch(() => {});
    await browser.close(); server.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
