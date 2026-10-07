// Actual Home/queries/account sheet/emblems; only HTTP and navigation are mocked.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.HOME_TIER_BROWSER_OUTPUT ?? '/tmp/trading-home-tiers';
const baseline = process.env.HOME_TIER_BASELINE_RESULTS ? JSON.parse(fs.readFileSync(process.env.HOME_TIER_BASELINE_RESULTS)).records : null;
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
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430, 768, 1280]) for (const fontScale of [1, 1.5, 2]) for (const long of [false, true]) for (const [tier, name] of Object.entries(tiers)) {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?tier=${tier}&fontScale=${fontScale}&long=${long ? 1 : 0}`);
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
        let image = null;
        const imageView = card.querySelector('[data-testid="home-tier-image"]');
        const img = imageView?.querySelector('img');
        if (img) {
          const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let alphaArea = 0; const bounds = [canvas.width, canvas.height, 0, 0];
          for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
            const alpha = pixels[(y * canvas.width + x) * 4 + 3];
            if (alpha <= 8) continue;
            alphaArea += alpha / 255;
            bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
            bounds[2] = Math.max(bounds[2], x + 1); bounds[3] = Math.max(bounds[3], y + 1);
          }
          const view = rect(imageView), sx = view.width / canvas.width, sy = view.height / canvas.height;
          const renderedScale = Math.min(sx, sy); // RN Web background-size: contain
          image = { sx, sy, fit: getComputedStyle(imageView.firstElementChild).backgroundSize,
            equivalentSize: Math.sqrt(alphaArea) * renderedScale,
            visibleWidth: (bounds[2] - bounds[0]) * renderedScale,
            visibleHeight: (bounds[3] - bounds[1]) * renderedScale };
        }
        const typography = selector => { const e = card.querySelector(selector), c = getComputedStyle(e); return { ...rect(e), size: parseFloat(c.fontSize), weight: Number(c.fontWeight) }; };
        const button = card.querySelector('[role="button"]');
        return { image, title: typography('[data-testid="home-account-title"]'), nickname: typography('[data-testid="home-nickname"]'), card: rect(card), emblem: rect(emblem), button: rect(button), clipped, overlaps, contrast, text: card.textContent, label: button.getAttribute('aria-label') };
      });
      assert.deepEqual(layout.clipped, [], JSON.stringify({ appearance, width, fontScale, tier, layout }));
      assert.deepEqual(layout.overlaps, [], 'text must not cover the emblem');
      assert.ok(layout.contrast.every(x => x.ratio >= 4.5), JSON.stringify(layout.contrast));
      assert.ok(layout.button.width >= 44 && layout.button.height >= 44); assert.match(layout.label, /계정 변경.*Season 1/);
      assert.ok(layout.emblem.right <= layout.card.right);
      assert.doesNotMatch(layout.text, /현재 순위|최종 순위|현재 등급|최종 등급|변경/);
      if (tier === 'null') assert.equal(await id('home-tier-image').count(), 0);
      else assert.equal(await id(`home-emblem-${tier === 'master' ? 'whale' : tier}`).count(), 1);
      if (layout.image) {
        assert.ok(Math.abs(layout.image.sx / layout.image.sy - 1) < .0002, 'uniform image scaling at the raster layout precision');
        assert.equal(layout.image.fit, 'contain');
        const index = Object.keys(tiers).indexOf(tier);
        const expected = 128 * (1 + index * .01) * (width < 360 ? 132 / 160 : 1);
        assert.ok(Math.abs(layout.image.equivalentSize - expected) < .03, 'rendered alpha area keeps the 1% progression');
      }
      assert.ok(layout.title.size > 16 * fontScale && layout.title.weight > 600);
      assert.ok(layout.nickname.size > 15 * fontScale && layout.nickname.weight > 600);
      if (fontScale === 1 && !long) {
        assert.ok(layout.emblem.y < layout.title.bottom, 'emblem uses the top title band');
        const before = baseline?.find(r => r.appearance === appearance && r.width === width && r.fontScale === fontScale && r.tier === tier);
        if (before) assert.ok(layout.card.height <= before.layout.card.height * .9, 'at least 10% less card height while preserving the visible emblem area');
      }
      if (width === 390 && fontScale === 1 && !long) {
        await id('home-account-context').screenshot({ path: path.join(out, `${tier}-${appearance}.png`) });
        if (tier === 'master') await page.screenshot({ path: path.join(out, `home-whale-${appearance}.png`) });
      }
      if (width === 320 && fontScale === 2 && long && tier === 'master') await id('home-account-context').screenshot({ path: path.join(out, `large-text-${appearance}.png`) });
      records.push({ appearance, width, fontScale, long, tier, layout });
    }
    for (const state of ['ranking-loading', 'ranking-error', 'ranking-unavailable', 'unranked']) {
      await page.goto(`${base}/?tier=master&state=${state}`); await id('home-tier-neutral').waitFor();
      assert.equal(await id('home-tier-image').count(), 0);
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
      await page.setViewportSize({ width: 1122, height: 510 });
      await page.setContent(`<html><body style="margin:0;padding:18px;background:${appearance === 'light' ? '#fcfcfd' : '#15171c'};display:grid;grid-template-columns:repeat(3,358px);gap:6px">${Object.keys(tiers).filter(t => t !== 'null').map(t => `<img width="358" src="${base}/capture/${t}-${appearance}.png">`).join('')}</body></html>`);
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
