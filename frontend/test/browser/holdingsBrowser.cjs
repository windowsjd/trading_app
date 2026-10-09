// Production React Native components rendered by RN Web. Device font scaling
// is modeled at the native boundary, without truncating any financial text.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.HOLDINGS_BROWSER_OUTPUT ?? '/tmp/trading-holdings-browser';
async function overflow(page) {
  return page.evaluate(() => [...document.querySelectorAll('#root div, #root span')].flatMap(el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width || !r.height) return [];
    if (r.left < -1 || r.right > innerWidth + 1) return [{ text: el.textContent.slice(0, 100), reason: 'box', bounds: [r.left, r.right] }];
    if (el.childNodes.length !== 1 || el.firstChild.nodeType !== Node.TEXT_NODE) return [];
    return [...el.textContent.matchAll(/\S+/gu)].flatMap(m => {
      const range = document.createRange(); range.setStart(el.firstChild, m.index); range.setEnd(el.firstChild, m.index + m[0].length);
      return [...range.getClientRects()].filter(t => t.left < r.left - 1 || t.right > r.right + 1
        || (s.overflow === 'hidden' && (t.top < r.top - 1 || t.bottom > r.bottom + 1)))
        .map(t => ({ text: el.textContent, reason: 'glyph', bounds: [t.left, t.right, r.left, r.right] }));
    });
  }));
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  const mocks = path.join(__dirname, 'holdingsMocks.js');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'holdingsFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'http-navigation-native-boundaries', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(^@react-navigation\/elements$|services\/api\/client$|navigationHooks$)/ }, () => ({ path: mocks }));
    } }], logLevel: 'warning' });
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/bundle.js"></script>';
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', req.url.startsWith('/bundle.js') ? 'text/javascript' : 'text/html');
    res.end(req.url.startsWith('/bundle.js') ? fs.readFileSync(path.join(out, 'bundle.js')) : html); }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] })
    .catch(error => { server.close(); throw error; });
  const base = `http://127.0.0.1:${server.address().port}`, results = [], flows = [], errors = [];
  let page;
  async function visit(options) {
    if (page) await page.close();
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.setViewportSize({ width: options.width ?? 320, height: 844 });
    await page.emulateMedia({ colorScheme: options.theme ?? 'light' });
    await page.goto(`${base}/?holdings=1&${new URLSearchParams(options)}`);
    await page.waitForFunction(() => window.holdingsFixture?.accounts.selectedAccountId);
    await page.evaluate(value => window.holdingsFixture.appearance.setPreference(value), options.theme ?? 'light');
    await page.waitForFunction(value => window.holdingsFixture.appearance.mode === value, options.theme ?? 'light');
    return page;
  }
  async function ready(screen) {
    if (screen === 'home') { await page.getByTestId('home-holdings').waitFor();
      const toggle = page.getByTestId('home-holdings-toggle'); if (await toggle.count()) await toggle.click(); }
    else if (screen === 'wallet') await page.getByTestId('wallet-holdings-title').waitFor();
    else if (screen === 'portfolio') await page.getByText('보유종목', { exact: true }).waitFor();
    else if (screen === 'market-holdings') { await page.getByTestId('holdings-filter-all').click(); await page.getByTestId('spot-card-btc').waitFor(); }
    else if (screen === 'friend') await page.getByTestId('friend-spot-btc').waitFor();
    else await page.getByTestId(/futures-position-.*:position$/).waitFor();
    await page.waitForTimeout(60);
  }
  try {
    for (const width of [320, 360, 390, 430]) for (const theme of ['light', 'dark']) for (const fontScale of [1, 2])
      for (const screen of ['home', 'wallet', 'portfolio', 'market-holdings', 'friend', 'futures']) {
        const modes = screen === 'home' ? ['general', 'season', 'beginner'] : ['general'];
        for (const mode of modes) {
          await visit({ screen, mode, width, theme, fontScale, long: 1, kind: 'mixed' }); await ready(screen);
          if (['home', 'wallet', 'portfolio'].includes(screen)) await page.getByText('포지션', { exact: true }).waitFor();
          if (screen === 'friend') {
            assert.equal(await page.getByTestId(/holding-protection-|futures-protection-|futures-submit|futures-position-.*-(increase|reduce|close)$/).count(), 0);
            assert.equal(await page.getByText('자산 비중 33.33%', { exact: true }).count(), 3);
          }
          if (screen === 'futures') assert.equal(await page.getByText('예상 청산가', { exact: true }).count(), 0);
          assert.deepEqual(await overflow(page), [], `${screen}/${mode}/${width}/${theme}/${fontScale}`);
          const label = `${screen}-${mode}-${width}-${theme}-${fontScale}`; results.push(label);
          if (width === 320 && fontScale === 2) {
            const target = screen === 'home' ? page.getByTestId('home-holdings') : screen === 'wallet' ? page.getByTestId('wallet-futures')
              : screen === 'portfolio' ? page.getByTestId('portfolio-futures') : screen === 'market-holdings' ? page.getByTestId('holding-btc')
                : screen === 'friend' ? page.getByTestId('friend-futures-asset-btc') : page.getByTestId(/futures-position-.*:position$/);
            await target.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, label + '.png') });
          }
        }
      }
    for (const screen of ['home', 'wallet', 'portfolio']) for (const kind of ['spot-error', 'futures-error', 'spot-delay', 'futures-delay']) {
      await visit({ screen, kind, fontScale: 2 });
      const future = page.getByTestId(new RegExp(`^${screen}-futures-.*:position$`));
      if (kind.startsWith('spot-')) { await future.waitFor(); assert.equal(await page.getByText('보유종목 및 포지션이 없습니다.', { exact: true }).count(), 0); }
      else { await page.getByText('보유수량 12 주', { exact: true }).waitFor(); assert.equal(await future.count(), 0); }
      if (kind.endsWith('error')) await page.getByText(kind.startsWith('spot-') ? /보유.*불러오지 못했습니다/ : '포지션을 불러오지 못했습니다.').waitFor();
      assert.deepEqual(await overflow(page), [], `${screen}/${kind}`); flows.push(`${screen}/${kind}`);
    }
    for (const mode of ['general', 'season', 'beginner']) for (const kind of ['stock-only', 'us-only', 'crypto-only', 'futures-only', 'empty']) {
      await visit({ screen: 'home', mode, kind });
      await page.getByTestId('home-holdings').waitFor(); await page.waitForTimeout(60);
      const future = page.getByTestId(/^home-futures-.*:position$/);
      assert.equal(await future.count(), kind === 'futures-only' ? 1 : 0);
      assert.equal(await page.getByText('보유종목 및 포지션이 없습니다.', { exact: true }).count(), kind === 'empty' ? 1 : 0);
      flows.push(`${mode}/${kind}`);
    }
    for (const kind of ['mark-stale', 'spot-unavailable', 'spot-stale']) {
      await visit({ screen: 'wallet', kind }); await page.getByTestId('wallet-futures').waitFor();
      if (kind === 'mark-stale') { await page.getByText('Mark 확인 불가 · 평가 대기', { exact: true }).waitFor();
        assert.equal(await page.getByTestId('wallet-futures-general-account:position-notional').textContent(), '-'); }
      else await page.getByText(kind === 'spot-stale' ? '이전 시세 · 최신 시세 확인 불가' : '현재 시세 조회 불가', { exact: true }).first().waitFor();
      flows.push(kind);
    }
    await visit({ screen: 'friend', kind: 'mixed' }); await ready('friend');
    await page.evaluate(() => { const f = window.holdingsFixture; f.transport.hold('friend'); void f.client.refetchQueries({ predicate: q => q.queryKey.includes('friend') }); });
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId('friend-spot-btc').count(), 0, 'sensitive data is hidden during permission revalidation');
    await page.evaluate(() => { window.holdingsFixture.transport.permission = 'private'; window.holdingsFixture.transport.release(); });
    await page.getByText('이 사용자는 포트폴리오를 비공개로 설정했습니다.', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('friend-futures-asset-btc').count(), 0);
    assert.equal(await page.evaluate(() => [...window.holdingsFixture.client.getQueryCache().getAll()].some(q => q.state.data?.portfolio)), false);
    flows.push('friend permission revoked during read: DOM and cache cleared');
    await visit({ screen: 'friend', kind: 'mixed' }); await ready('friend');
    await page.evaluate(() => {
      const f = window.holdingsFixture;
      f.transport.hold('friend');
      void f.client.refetchQueries({ predicate: q => q.queryKey.includes('friend') });
      f.navigation.setFocused(false);
    });
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId('friend-spot-btc').count(), 0);
    await page.evaluate(() => window.holdingsFixture.transport.release());
    await page.waitForFunction(() => [...window.holdingsFixture.client.getQueryCache().getAll()]
      .filter(q => q.queryKey.includes('friend')).every(q => q.state.fetchStatus === 'idle'));
    assert.equal(await page.evaluate(() => [...window.holdingsFixture.client.getQueryCache().getAll()].some(q => q.state.data?.portfolio)), false,
      'a delayed financial response after blur is removed from the cache');
    await page.evaluate(() => window.holdingsFixture.navigation.setFocused(true));
    await page.getByTestId('friend-spot-btc').waitFor();
    flows.push('friend blurred during read: delayed financial cache cleared, fresh focus refetched');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ layouts: results.length, results, flows, errors,
      scope: 'Production RN components via RN Web; native host tests are separate, physical Android/iOS devices not exercised' }, null, 2));
    console.log(`Holdings browser PASS ${results.length} layouts + ${flows.length} separation/privacy flows`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
