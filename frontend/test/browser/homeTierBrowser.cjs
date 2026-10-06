// Actual Home/queries/account sheet/vectors; only HTTP and navigation are mocked.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.HOME_TIER_BROWSER_OUTPUT ?? '/tmp/trading-home-tiers';
const tiers = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', master: 'Whale', null: '티어 미정' };
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'homeFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'home-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks)$/ }, () => ({ path: path.join(__dirname, 'homeMocks.js') }));
    } }], logLevel: 'warning' });
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>';
  const server = http.createServer((req, res) => {
    const file = req.url === '/bundle.js' ? 'bundle.js' : req.url.startsWith('/capture/') ? path.basename(req.url) : null;
    res.setHeader('Content-Type', file?.endsWith('.png') ? 'image/png' : file ? 'text/javascript' : 'text/html');
    res.end(file ? fs.readFileSync(path.join(out, file)) : html);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); const errors = [], records = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  await page.addInitScript(() => { localStorage.setItem('selectedTradingAccountId:home-user', 'season-account'); localStorage.setItem('trading-app:appearance', 'system'); });
  const id = name => page.getByTestId(name);
  const switchAccount = async accountId => {
    await id('trading-account-switcher-trigger').click(); await id(`trading-account-switcher-option-${accountId}`).click();
    await id('trading-account-switcher-sheet').waitFor({ state: 'hidden' });
  };
  try {
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2]) for (const [tier, name] of Object.entries(tiers)) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?tier=${tier}&fontScale=${fontScale}&long=${fontScale > 1 ? 1 : 0}`);
      await id('home-tier').filter({ hasText: name }).waitFor(); await id('home-nickname').waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="home-account-context"] img')].every(i => i.complete && i.naturalWidth > 0));
      const layout = await id('home-account-context').evaluate(card => {
        const box = card.getBoundingClientRect(); const clipped = [], overlaps = [], contrast = [];
        const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const emblem = card.querySelector('[data-testid^="home-emblem-"]') ?? card.querySelector('[data-testid="home-tier-neutral"]');
        const emblemBox = emblem.getBoundingClientRect();
        const luminance = value => { const c = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
        const background = luminance(getComputedStyle(card).backgroundColor);
        const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) {
          const t = walk.currentNode; if (!t.textContent.trim() || t.parentElement.closest('[aria-hidden="true"]')) continue;
          const range = document.createRange(); range.selectNodeContents(t);
          for (const r of range.getClientRects()) {
            if (r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom) clipped.push(t.textContent);
            if (r.left < emblemBox.right && r.right > emblemBox.left && r.top < emblemBox.bottom && r.bottom > emblemBox.top) overlaps.push(t.textContent);
          }
          const foreground = luminance(getComputedStyle(t.parentElement).color);
          contrast.push({ text: t.textContent, ratio: (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05) });
        }
        const button = card.querySelector('[role="button"]');
        return { card: rect(card), emblem: rect(emblem), button: rect(button), clipped, overlaps, contrast, text: card.textContent, label: button.getAttribute('aria-label') };
      });
      assert.deepEqual(layout.clipped, [], JSON.stringify({ appearance, width, fontScale, tier, layout }));
      assert.deepEqual(layout.overlaps, [], 'text must not cover the emblem');
      assert.ok(layout.contrast.every(x => x.ratio >= 4.5), JSON.stringify(layout.contrast));
      assert.ok(layout.button.width >= 44 && layout.button.height >= 44); assert.match(layout.label, /계정 변경.*Season 1/);
      assert.ok(layout.emblem.width >= 132); assert.ok(layout.emblem.right <= layout.card.right);
      assert.doesNotMatch(layout.text, /현재 순위|최종 순위|현재 등급|최종 등급|변경/);
      if (tier === 'null') assert.equal(await id('home-tier-frame').count(), 0);
      else assert.equal(await id(`home-emblem-${tier === 'master' ? 'whale' : tier}`).count(), 1);
      if (width === 390 && fontScale === 1) {
        await id('home-account-context').screenshot({ path: path.join(out, `${tier}-${appearance}.png`) });
        if (tier === 'master') await page.screenshot({ path: path.join(out, `home-whale-${appearance}.png`) });
      }
      if (width === 320 && fontScale === 2 && tier === 'master') await id('home-account-context').screenshot({ path: path.join(out, `large-text-${appearance}.png`) });
      records.push({ appearance, width, fontScale, tier, layout });
    }
    for (const state of ['ranking-loading', 'ranking-error', 'ranking-unavailable', 'unranked']) {
      await page.goto(`${base}/?tier=master&state=${state}`); await id('home-tier-neutral').waitFor();
      assert.equal(await id('home-tier-frame').count(), 0);
      assert.equal(await id('home-tier').textContent(), state === 'ranking-loading' ? '티어 확인 중' : state === 'ranking-error' ? '티어 확인 실패' : '티어 미정');
      if (state === 'ranking-loading') {
        await switchAccount('general-account'); await page.evaluate(() => window.fixture.transport.release());
        await id('home-nickname').waitFor(); assert.equal(await id('home-tier').count(), 0);
      }
      records.push({ state });
    }
    await page.goto(`${base}/?tier=unknown`); await id('home-tier-neutral').waitFor(); assert.equal(await id('home-tier').textContent(), '티어 미정');
    await page.goto(`${base}/?tier=master&past=1`); await id('home-emblem-whale').waitFor();
    await switchAccount('past-account'); await id('home-emblem-diamond').waitFor(); assert.equal(await id('home-rank').textContent(), '#245');
    assert.match(await id('home-account-context').textContent(), /지난 시즌.*종료.*정산 완료/);
    const calls = await page.evaluate(() => window.fixture.transport.requests.filter(r => r.startsWith('/ranking?')));
    assert.ok(calls.some(r => /seasonId=past-season/.test(r) && /rankType=final/.test(r)));
    await switchAccount('general-account'); await id('home-nickname').waitFor(); assert.equal(await id('home-tier').count(), 0); assert.equal(await id('home-rank').count(), 0);
    await switchAccount('season-account'); await id('home-emblem-whale').waitFor(); assert.equal(await id('home-rank').textContent(), '#2');
    records.push({ scenario: 'active-past-general-active', calls });
    for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width: 1122, height: 940 });
      await page.setContent(`<html><body style="margin:0;padding:18px;background:${appearance === 'light' ? '#fcfcfd' : '#15171c'};display:grid;grid-template-columns:repeat(3,358px);gap:6px">${Object.keys(tiers).map(t => `<img width="358" src="${base}/capture/${t}-${appearance}.png">`).join('')}</body></html>`);
      await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth));
      await page.screenshot({ path: path.join(out, `tiers-${appearance}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ records, errors }, null, 2));
    console.log(`PASS ${records.length} layout/state/switch records`);
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: String(error), errors, completed: records.length }, null, 2)); throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
