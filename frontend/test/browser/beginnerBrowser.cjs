// Same external esbuild/Playwright runtime as the existing browser checks.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.BEGINNER_BROWSER_OUTPUT ?? '/tmp/trading-beginner-browser';

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'mainTabHeadersFixture.jsx')], outfile: path.join(out, 'app.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'beginner-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'mainTabHeadersNativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook)$/ }, () => ({ path: path.join(__dirname, 'beginnerMocks.js') }));
      b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/app.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'app.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/app.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  const results = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(process.env.BEGINNER_CHROMIUM ? { executablePath: process.env.BEGINNER_CHROMIUM } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const params = new URLSearchParams(location.search);
      localStorage.setItem('selectedTradingAccountId:home-user', `${params.get('account') ?? 'beginner'}-account`);
      localStorage.setItem('trading-app:appearance', params.get('theme') ?? 'light');
    });
    const id = value => page.getByTestId(value).filter({ visible: true }).first();
    const tab = label => page.getByRole('tablist').getByRole('tab', { name: label, exact: true });
    async function open(query = '') { await page.goto(`${base}/?${query}`); await id('home-account-title').waitFor(); }
    async function settled(testId) {
      await page.waitForFunction(testId => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!element?.checkVisibility()) return false;
        for (let parent = element; parent; parent = parent.parentElement) {
          if (Number(getComputedStyle(parent).opacity) < 0.999) return false;
        }
        return true;
      }, testId);
    }
    async function geometry() {
      const bounds = await page.evaluate(() => ['quests', 'guide'].map(section => {
        const element = document.querySelector(`[data-testid="beginner-segment-${section}"]`);
        const r = element.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height, inside: text.left >= r.left - 1 && text.right <= r.right + 1 && text.top >= r.top - 1 && text.bottom <= r.bottom + 1 };
      }));
      assert.equal(bounds.every(b => b.height >= 44 && b.inside), true);
      assert.equal(bounds[0].right <= bounds[1].left, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const labelsFit = await page.getByRole('tablist').getByRole('tab').evaluateAll(tabs => tabs.every(tab => {
        const hit = tab.getBoundingClientRect();
        const label = [...tab.querySelectorAll('*')].find(node => node.childNodes.length === 1 && node.firstChild.nodeType === Node.TEXT_NODE);
        if (!label) return false;
        const box = label.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(label);
        const glyph = range.getBoundingClientRect();
        return hit.width >= 44 && hit.height >= 44 && glyph.left >= box.left - 1 && glyph.right <= box.right + 1 && glyph.bottom <= hit.bottom + 1;
      }));
      assert.equal(labelsFit, true, 'all five tab labels fit their separate touch targets');
    }
    for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 2]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      await open(`fontScale=${fontScale}&theme=${theme}`);
      assert.equal(await id('home-account-title').textContent(), '초보 투자');
      await tab('퀘스트').click(); await id('beginner-quests-ready').waitFor();
      await settled('beginner-quests-ready');
      assert.equal(await page.getByRole('tablist').getByRole('tab').count(), 5);
      await tab('MY').waitFor();
      assert.doesNotMatch(await id('beginner-quests-ready').textContent(), /\d+%|경험치|레벨|해금|잠금/);
      await geometry();
      if (width === 320) await page.screenshot({ path: path.join(out, `quest-${fontScale}-${theme}.png`) });
      await id('beginner-segment-guide').click(); await id('guide-market-basics-card').waitFor();
      await geometry();
      await id('guide-market-basics-card').click();
      await page.getByRole('heading', { name: '시장기초', exact: true }).waitFor();
      await page.getByLabel(/back|뒤로/i).filter({ visible: true }).first().click();
      await id('beginner-segment-quests').click(); await id('beginner-quests-ready').waitFor();
      results.push({ width, fontScale, theme, segments: 'pass', guideNavigation: 'pass' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    for (const [account, title, third] of [['general-account', '일반 투자', '가이드'], ['season-account', 'Season 1', '랭킹'], ['beginner-account', '초보 투자', '퀘스트']]) {
      await id('trading-account-switcher-trigger').click();
      await id(`trading-account-switcher-option-${account}`).click();
      await page.waitForFunction(title => document.querySelector('[data-testid="home-account-title"]')?.textContent === title, title);
      await tab(third).waitFor();
      await tab('MY').waitFor();
      assert.equal(await page.evaluate(() => window.beginnerFixture.posts.length), 0);
    }

    // Exercise real Query observers and navigation while the transport holds responses.
    await open('account=general&holdings=1');
    await page.waitForFunction(() => document.querySelector('[data-testid="home-total-asset"]')?.textContent === '12,530,200원');
    await page.evaluate(() => {
      window.accountLeaks = [];
      new MutationObserver(() => {
        const title = document.querySelector('[data-testid="home-account-title"]')?.textContent;
        const expected = title === '초보 투자' ? ['10,000,000원', 'beginner-account'] : title === '일반 투자' ? ['12,530,200원', 'general-account'] : null;
        if (!expected) return;
        const amount = document.querySelector('[data-testid="home-total-asset"]')?.textContent;
        if (amount && amount !== expected[0]) window.accountLeaks.push({ title, amount });
        for (const row of document.querySelectorAll('[data-testid^="home-position-item-"]')) {
          if (row.checkVisibility() && !row.dataset.testid.includes(expected[1])) window.accountLeaks.push({ title, position: row.dataset.testid });
        }
      }).observe(document.getElementById('root'), { subtree: true, childList: true, characterData: true });
      window.beginnerFixture.delay = 'beginner-account';
    });
    async function switchTo(account) {
      await id('trading-account-switcher-trigger').click();
      await id(`trading-account-switcher-option-${account}-account`).click();
      await page.waitForFunction(title => document.querySelector('[data-testid="home-account-title"]')?.textContent === title, account === 'beginner' ? '초보 투자' : '일반 투자');
    }
    await switchTo('beginner');
    await page.waitForFunction(() => window.beginnerFixture.pending.length > 0);
    assert.equal(await page.getByTestId('home-total-asset').filter({ visible: true }).count(), 0, 'previous balance is absent while beginner loads');
    await page.evaluate(() => { window.beginnerFixture.delay = null; window.beginnerFixture.release(); });
    await page.waitForFunction(() => document.querySelector('[data-testid="home-total-asset"]')?.textContent === '10,000,000원');
    await id('home-position-item-beginner-account-asset-0').waitFor();
    const priorResponses = await page.evaluate(() => {
      window.beginnerFixture.delay = 'beginner-account';
      void window.fixture.client.invalidateQueries({ predicate: query => query.queryKey.includes('beginner-account') && query.queryKey.includes('portfolio') });
      return window.beginnerFixture.responses.filter(path => path === '/trading-accounts/beginner-account/portfolio').length;
    });
    await page.waitForFunction(() => window.beginnerFixture.pending.length > 0);
    await switchTo('general');
    await page.evaluate(() => { window.beginnerFixture.delay = null; window.beginnerFixture.release(); });
    await page.waitForFunction(prior => window.beginnerFixture.responses.filter(path => path === '/trading-accounts/beginner-account/portfolio').length > prior, priorResponses);
    await page.waitForFunction(() => document.querySelector('[data-testid="home-total-asset"]')?.textContent === '12,530,200원');
    assert.deepEqual(await page.evaluate(() => window.accountLeaks), []);
    await tab('지갑').click(); await id('wallet-cash-KRW').waitFor();
    assert.match(await id('wallet-cash-KRW').textContent(), /9,900,000/);
    await tab('홈').click(); await switchTo('beginner');
    await tab('지갑').click(); await id('wallet-cash-KRW').waitFor();
    assert.match(await id('wallet-cash-KRW').textContent(), /8,800,000/);
    assert.equal(await page.evaluate(() => window.beginnerFixture.posts.length), 0);
    await open('enabled=0');
    assert.notEqual(await id('home-account-title').textContent(), '초보 투자');
    await id('trading-account-switcher-trigger').click();
    assert.equal(await page.getByTestId('trading-account-switcher-option-beginner-account').count(), 0);
    assert.equal(await page.getByTestId('beginner-account-entry').count(), 0);
    await open('newBeginner=1&account=general');
    await id('trading-account-switcher-trigger').click();
    assert.equal(await page.evaluate(() => window.beginnerFixture.posts.length), 0);
    await id('beginner-account-start').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="home-account-title"]')?.textContent === '초보 투자');
    assert.deepEqual(await page.evaluate(() => window.beginnerFixture.posts), ['/trading-accounts/beginner']);
    await tab('퀘스트').waitFor();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, accountSwitching: 'pass', delayedFinancialIsolation: 'pass', disabledEntry: 'pass', explicitCreation: 'pass', errors }, null, 2));
    console.log(`beginner browser checks passed: ${results.length} layouts, guide navigation, three-mode switching, delayed financial isolation, disabled entry and explicit creation`);
  } finally { await browser?.close(); server.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
