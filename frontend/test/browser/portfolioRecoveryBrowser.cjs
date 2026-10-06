const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.PORTFOLIO_RECOVERY_OUTPUT ?? '/tmp/trading-portfolio-recovery';
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'portfolioRecoveryFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true,
    platform: 'browser', format: 'iife', mainFields: ['browser', 'module', 'main'], nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'transport-only', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /services\/api\/client$/ }, () => ({ path: path.join(__dirname, 'portfolioRecoveryMocks.js') }));
      b.onResolve({ filter: /useMarketTickers$/ }, () => ({ path: path.join(__dirname, 'portfolioRecoveryMocks.js') }));
      b.onResolve({ filter: /(useAssetTicker|useAssetCandle|useAssetOrderBook)$/ }, () => ({ path: path.join(__dirname, 'tradingMocks.js') }));
    } }], logLevel: 'warning' });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url.startsWith('/bundle.js') ? 'text/javascript' : 'text/html');
    res.end(req.url.startsWith('/bundle.js') ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser; const records = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const epoch = Date.now(), origin = performance.now(); Date.now = () => epoch + Math.round(performance.now() - origin);
      localStorage.clear(); localStorage.setItem('trading-app:appearance', new URLSearchParams(location.search).get('appearance') ?? 'light');
    });
    const id = value => page.getByTestId(value).filter({ visible: true }).first();
    const portfolioCount = () => page.evaluate(() => window.fixture.recovery.portfolioReads);
    const tab = async name => { await page.evaluate(name => window.fixture.navigationRef.navigate('MainTabs', { screen: name }), name); await page.waitForTimeout(280); };
    const login = async query => {
      await page.goto(`${base}/?${query}`); await id('auth-login-email-input').fill('home@example.invalid'); await id('auth-login-password-input').fill('fixture-password');
      await id('auth-login-submit').click();
      try { await id('mode-selection-season-continue-season-account').click({ timeout: 10000 }); }
      catch (error) {
        await page.screenshot({ path: path.join(out, 'entry-failure.png'), fullPage: true });
        console.error(await page.evaluate(() => ({ route: window.fixture.navigationRef.getCurrentRoute(), reads: window.fixture.recovery.reads,
          accountState: { isLoading: window.fixture.accounts.isLoading, isError: window.fixture.accounts.isError, selected: window.fixture.accounts.selectedAccountId, ids: window.fixture.accounts.accounts.map(a=>a.id) },
          queries: window.fixture.client.getQueryCache().getAll().map(q=>({key:q.queryKey,status:q.state.status,fetch:q.state.fetchStatus,observers:q.getObserversCount()})), text: document.body.textContent }))); throw error;
      }
      await id('home-account-context').waitFor();
      const flow = await page.evaluate(() => ({ reads: window.fixture.recovery.reads, selected: window.fixture.accounts.selectedAccountId }));
      assert.equal(flow.selected, 'season-account');
      assert.ok(flow.reads.filter(r => /portfolio$/.test(r.path)).every(r => r.authenticated));
      assert.equal(flow.reads.filter(r => r.method === 'post').length, 1, 'only login, no account creation');
    };
    for (const scenario of ['success', 'timeout-once', 'network-once', 'gateway-once', 'persistent', 'structural', 'generic500', 'ownership', 'unavailable']) {
      await login(`scenario=${scenario}&role=admin`);
      if (['success', 'timeout-once', 'network-once', 'gateway-once'].includes(scenario)) {
        await id('home-total-asset').waitFor();
        assert.equal(await portfolioCount(), scenario === 'success' ? 1 : 2);
        const before = await portfolioCount(); await tab('MarketTab'); await tab('HomeTab');
        assert.equal(await portfolioCount(), before, 'retained successful Home is not fetched on focus');
        await tab('WalletTab'); await tab('HomeTab'); assert.equal(await portfolioCount(), before, 'fresh Wallet reuses the same key');
      } else if (scenario === 'unavailable') {
        await page.getByText('수익률을 계산할 수 없습니다.', { exact: true }).first().waitFor();
        assert.equal(await page.getByText('포트폴리오 정보를 불러오지 못했습니다.', { exact: true }).count(), 0);
      } else {
        const structural = scenario === 'structural';
        await page.getByText(structural ? '데이터를 안전하게 표시할 수 없습니다.' : '포트폴리오 정보를 불러오지 못했습니다.', { exact: true }).waitFor();
        const expected = scenario === 'persistent' ? 2 : 1; assert.equal(await portfolioCount(), expected);
        assert.match(await id('home-account-context').textContent(), /Season 1/);
        await id('admin-diagnostic-toggle').click();
        const panel = (await id('admin-diagnostic-content').textContent()).replace(/\u200b/g, '');
        assert.match(panel, /c25c9d0a-220d-43eb-a939-7733f63e21bc/);
        assert.match(panel, structural ? /portfolio_valuation_validation/ : /httpStatus/);
        assert.doesNotMatch(panel, /Raw secret|fixture-access|provider\/database/);
        await page.screenshot({ path: path.join(out, `${scenario}-diagnostic.png`), fullPage: true });
        if (scenario === 'persistent') {
          // Two manual retry cycles can also fail. The service recovers later,
          // independently of which tab was visited.
          for (let i = 0; i < 2; i++) {
            await page.getByText('다시 시도', { exact: true }).click();
            await page.waitForFunction(count => window.fixture.recovery.portfolioReads === count && window.fixture.client.getQueryState(window.fixture.portfolioKey)?.fetchStatus === 'idle', expected + (i + 1) * 2);
          }
          await page.evaluate(() => { window.fixture.recovery.repaired = true; });
          // Recovery with the existing retry button needs no navigation.
          await page.getByText('다시 시도', { exact: true }).click(); await id('home-total-asset').waitFor();
          const before = await portfolioCount(); await tab('MarketTab'); await tab('HomeTab'); assert.equal(await portfolioCount(), before);
        } else {
          await tab('MarketTab'); await tab('HomeTab'); assert.equal(await portfolioCount(), expected, 'non-transient errors never focus-retry');
          await tab('WalletTab'); await tab('HomeTab'); assert.equal(await portfolioCount(), expected, 'another observer never hides structural/auth/generic500 faults');
        }
      }
      records.push({ scenario, reads: await page.evaluate(() => window.fixture.recovery.reads), failures: await page.evaluate(() => window.fixture.recovery.failures) });
    }
    // Focus and Wallet-mount recovery are distinct; both reuse the account key.
    for (const via of ['focus', 'wallet']) {
      await login('scenario=persistent'); await page.getByText('포트폴리오 정보를 불러오지 못했습니다.', { exact: true }).waitFor();
      assert.equal(await portfolioCount(), 2); await tab('MarketTab');
      await page.evaluate(() => { window.fixture.recovery.repaired = true; });
      await tab(via === 'focus' ? 'HomeTab' : 'WalletTab');
      await id(via === 'focus' ? 'home-total-asset' : 'wallet-exchange').waitFor();
      await tab('HomeTab'); await id('home-total-asset').waitFor(); assert.equal(await portfolioCount(), 3);
      records.push({ recoveryVia: via, count: await portfolioCount() });
    }
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 2]) for (const role of ['user', 'admin']) {
      await page.setViewportSize({ width, height: 900 });
      await login(`scenario=${role === 'admin' ? 'structural' : 'generic500'}&role=${role}&appearance=${appearance}&fontScale=${fontScale}`);
      const title = page.getByText(role === 'admin' ? '데이터를 안전하게 표시할 수 없습니다.' : '포트폴리오 정보를 불러오지 못했습니다.', { exact: true });
      await title.waitFor();
      if (role === 'user') {
        assert.equal(await id('admin-diagnostic-panel').count(), 0);
        assert.doesNotMatch(await page.locator('body').textContent(), /Raw secret|httpStatus|INTERNAL_SERVER_ERROR|fixture-access/);
      } else {
        await id('admin-diagnostic-toggle').click();
        const clipped = await id('admin-diagnostic-content').evaluate(el => {
          const boundary = el.getBoundingClientRect(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), bad = [];
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
            for (const r of range.getClientRects()) if (r.left < boundary.left - 1 || r.right > boundary.right + 1) bad.push(walker.currentNode.textContent);
          }
          return bad;
        });
        assert.deepEqual(clipped, [], 'safe diagnostics wrap at large font scales');
        if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `${appearance}-admin-large-font.png`), fullPage: true });
      }
      assert.ok(await title.evaluate(el => { const r = el.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth; }));
      records.push({ appearance, width, fontScale, role });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ flows: records.length, errors, out }));
  } finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ records, errors }, null, 2)); await browser?.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
