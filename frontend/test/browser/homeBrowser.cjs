// Reuses the external browser tools and native font-scale adapter. Only HTTP
// and navigation are fixture boundaries; no credentials or external requests.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const theme = require('./appearanceAssertions.cjs');
const root = path.resolve(__dirname, '../..');
const out = process.env.HOME_BROWSER_OUTPUT ?? '/tmp/trading-home-browser';

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'homeFixture.jsx')],
    outfile: path.join(out, 'bundle.js'), bundle: true, minify: true,
    platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'isolated-home-transport', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks)$/ }, () => ({ path: path.join(__dirname, 'homeMocks.js') }));
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
  const errors = [], records = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('restore') !== '1') {
      localStorage.setItem('selectedTradingAccountId:home-user', p.get('mode') === 'general' ? 'general-account' : 'season-account');
      localStorage.setItem('trading-app:appearance', 'system');
    }
  });
  const id = (name) => page.getByTestId(name);
  const switchAccount = async (accountId) => {
    await id('trading-account-switcher-trigger').click();
    await id(`trading-account-switcher-option-${accountId}`).click();
    await id('trading-account-switcher-sheet').waitFor({ state: 'hidden' });
  };
  try {
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920])
      for (const fontScale of [1, 1.5, 2]) for (const mode of ['general', 'season']) for (const long of [0, 1]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: appearance });
        await page.goto(`${base}/?mode=${mode}&fontScale=${fontScale}&long=${long}`);
        await id('home-total-asset').waitFor();
        if (mode === 'season') await id('home-nickname').waitFor();
        await theme.canvas(page, appearance);
        await theme.background(id('home-account-context'), appearance, 'surface');
        await theme.background(id('home-summary-card'), appearance, 'screen');
        if (mode === 'season') await theme.background(id('home-competition'), appearance, 'surface');
        const heroText = await id('home-summary-card').textContent();
        assert.doesNotMatch(heroText, /\(초기자본 대비\)/);
        assert.match(heroText, mode === 'season' ? /시즌 수익률 -3\.52%/ : /시간가중 수익률 4\.82%/);
        const layout = await page.evaluate(() => {
          const node = (name) => document.querySelector(`[data-testid="${name}"]`);
          const box = (name) => {
            const el = node(name), r = el.getBoundingClientRect(), css = getComputedStyle(el);
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, fontSize: parseFloat(css.fontSize), color: css.color, background: css.backgroundColor, borderColor: css.borderTopColor, borderWidth: parseFloat(css.borderTopWidth), paddingHorizontal: parseFloat(css.paddingLeft), paddingVertical: parseFloat(css.paddingTop) };
          };
          const clipped = [];
          for (const name of ['home-account-context', 'home-summary-card', 'home-competition']) {
            const el = node(name);
            if (!el) continue;
            const boundary = el.getBoundingClientRect();
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
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
          const title = node('home-account-context').firstElementChild.firstElementChild;
          const titleRange = document.createRange(); titleRange.selectNodeContents(title);
          const titleTextRight = Math.max(...[...titleRange.getClientRects()].map((r) => r.right));
          const luminance = (color) => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map((s) => {
              const n = Number(s) / 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
          };
          const contrasts = [...node('home-summary-card').querySelectorAll('div, span')].filter((el) => el.textContent.trim()).map((el) => {
            const css = getComputedStyle(el);
            const fg = luminance(css.color), bg = luminance(getComputedStyle(document.documentElement).backgroundColor);
            return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
          });
          return {
            context: box('home-account-context'), total: box('home-total-asset'),
            trigger: box('trading-account-switcher-trigger'),
            competition: node('home-competition') ? box('home-competition') : null,
            text: node('home-account-context').textContent, clipped, titleTextRight, contrasts,
          };
        });
        assert.deepEqual(layout.clipped, [], JSON.stringify({ appearance, width, fontScale, mode, long }));
        const contentWidth = Math.min(width, 1120) - 32;
        assert.ok(Math.abs(layout.context.width - contentWidth) <= 1, 'Home uses the shared desktop content width');
        assert.ok(Math.abs(layout.context.x - (width - contentWidth) / 2) <= 1, 'content stays centered');
        assert.ok(layout.context.height >= 72 && layout.trigger.height >= 44);
        assert.ok(layout.trigger.width >= 44);
        assert.ok(layout.context.paddingHorizontal >= 16 && layout.context.paddingVertical >= 12);
        assert.equal(layout.context.borderWidth, 1);
        assert.equal(layout.context.borderColor, appearance === 'light' ? 'rgb(229, 232, 235)' : 'rgb(67, 83, 100)');
        assert.notEqual(layout.context.background, theme.palettes[appearance].screen);
        assert.ok(layout.trigger.right <= layout.context.right - 12);
        assert.ok(layout.titleTextRight <= layout.trigger.x + 1, `title and change trigger never collide: ${layout.titleTextRight} / ${layout.trigger.x}`);
        assert.ok(layout.contrasts.every((ratio) => ratio >= 4.5), 'Hero text and financial colors have readable contrast');
        assert.ok(layout.total.y >= layout.context.bottom && layout.total.right <= width);
        assert.ok(layout.total.fontSize >= 36 * fontScale);
        assert.ok(!/진행 중|참가 중|운영 중|투자 계정/.test(layout.text));
        assert.equal(!!layout.competition, mode === 'season');
        if (layout.competition) assert.ok(layout.competition.y >= layout.total.bottom);
        if (!long && fontScale === 1) {
          assert.ok(layout.context.height <= 80, 'normal context stays compact');
          assert.ok(layout.total.bottom <= 230, 'assets appear near the top');
          await page.screenshot({ path: path.join(out, `${mode}-${appearance}-${width}.png`) });
        }
        if (long && width === 320 && fontScale === 2) await page.screenshot({
          path: path.join(out, `${mode}-${appearance}-320-large-text.png`), fullPage: true,
        });
        records.push({ appearance, width, fontScale, mode, long, heroText, layout });
      }

    for (const appearance of ['light', 'dark']) for (const state of [
      'upcoming', 'ended', 'settled', 'suspended', 'closed', 'registered', 'excluded', 'finished',
      'portfolio-error', 'empty-summary', 'loading', 'ranking-error', 'ranking-integrity', 'unranked',
    ]) {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?state=${state}`);
      await id('home-account-context').waitFor();
      await theme.canvas(page, appearance);
      if (state === 'portfolio-error') await page.getByText('계정 정보를 불러오지 못했습니다.', { exact: true }).waitFor();
      else if (state === 'empty-summary') await page.getByText('수익률을 계산할 수 없습니다.', { exact: true }).waitFor();
      else if (state === 'ranking-integrity') await id('trading-account-integrity-error').waitFor();
      else if (state === 'loading') assert.equal(await id('home-total-asset').count(), 0);
      else {
        await id('home-total-asset').waitFor();
        if (state === 'ranking-error') await page.getByText(/랭킹 정보를 불러오지 못했습니다/).waitFor();
        else if (state === 'unranked') assert.equal(await id('home-rank').textContent(), '-');
        else {
          await id('trading-account-capability-notice').waitFor();
          assert.equal(await page.getByText('환전하기', { exact: true }).count(), 0);
          if (state === 'settled') {
            assert.equal(await id('home-tier').textContent(), 'Gold');
            await page.getByText('보상 확인', { exact: true }).click();
            assert.deepEqual(await page.evaluate(() => window.fixture.navigation.calls.at(-1)), ['MainTabs', { screen: 'MyTab', params: { screen: 'Reward' } }]);
          }
        }
      }
      await switchAccount('general-account');
      assert.equal(await id('home-account-context').textContent(), '일반 투자변경');
      records.push({ appearance, state });
    }

    await page.goto(`${base}/`);
    await id('home-total-asset').waitFor();
    assert.equal(await id('home-total-asset').textContent(), '9,648,192원');
    await page.evaluate(() => {
      const f = window.fixture;
      f.transport.delay = 'season-account';
      void f.client.resetQueries({ queryKey: ['tradingAccount', 'portfolio', 'season-account', 'overview'] });
    });
    await id('home-total-asset').waitFor({ state: 'hidden' });
    await switchAccount('general-account');
    await id('home-total-asset').waitFor();
    assert.equal(await id('home-total-asset').textContent(), '12,530,200원');
    await page.evaluate(() => { window.fixture.transport.delay = null; window.fixture.transport.release(); });
    await page.waitForTimeout(50);
    assert.equal(await id('home-total-asset').textContent(), '12,530,200원');
    assert.equal(await id('home-competition').count(), 0);
    assert.match(await id('home-summary-card').textContent(), /시간가중 수익률 4\.82%/);
    await page.getByText('원장 보기', { exact: true }).click();
    await page.getByText('주문 내역 보기', { exact: true }).click();
    await page.getByText('환전하기', { exact: true }).click();
    const calls = await page.evaluate(() => window.fixture.navigation.calls);
    assert.deepEqual(calls, [
      ['WalletTransactions'],
      ['MainTabs', { screen: 'RecordTab', params: { screen: 'RecordOrderList', params: { accountId: 'general-account' } } }],
      ['WalletFx'],
    ]);
    await page.evaluate(() => window.fixture.appearance.setPreference('light'));
    await page.waitForFunction(() => document.documentElement.style.colorScheme === 'light');
    await theme.canvas(page, 'light');
    await page.evaluate(() => window.fixture.appearance.setPreference('dark'));
    await page.waitForFunction(() => document.documentElement.style.colorScheme === 'dark');
    await theme.canvas(page, 'dark');
    await page.waitForFunction(() => localStorage.getItem('trading-app:appearance') === 'dark');
    await page.goto(`${base}/?restore=1`);
    await id('home-total-asset').waitFor();
    assert.equal(await id('home-total-asset').textContent(), '12,530,200원');
    await theme.canvas(page, 'dark');
    await page.evaluate(() => window.fixture.appearance.setPreference('system'));
    for (const mode of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForFunction((expected) => document.documentElement.style.colorScheme === expected, mode);
      await theme.canvas(page, mode);
    }
    await switchAccount('season-account');
    assert.equal(await id('home-total-asset').textContent(), '9,648,192원');
    assert.equal(await id('home-nickname').textContent(), '김재민');
    const seasonHeroText = await id('home-summary-card').textContent();
    assert.match(seasonHeroText, /시즌 수익률 -3\.52%/);
    assert.doesNotMatch(seasonHeroText, /\(초기자본 대비\)/);
    const requests = await page.evaluate(() => window.fixture.transport.requests);
    assert.ok(requests.some((request) => request.includes('/ranking?') && request.includes('seasonId=season-1')));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ records, switching: 'passed', navigation: 'passed', persistence: 'passed', appearance: 'passed', errors }, null, 2));
    for (const name of ['failure.json', 'failure.png']) fs.rmSync(path.join(out, name), { force: true });
    console.log(`HOME_BROWSER_PASSED ${records.length} layouts/states + switching, stale response, navigation, storage and appearance`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ records, errors, message: error.message }, null, 2));
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
    throw error;
  } finally { await browser.close(); server.close(); }
}
run().catch((error) => { console.error(error); process.exit(1); });
