// Actual Home/queries/account sheet/emblems; only HTTP and navigation are mocked.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.HOME_TIER_BROWSER_OUTPUT ?? '/tmp/trading-home-tiers';
const quick = process.env.HOME_TIER_QUICK === '1';
const optical = { bronze: 1, silver: 1.005, gold: 1.01, platinum: 1.015, diamond: .985, master: 1.065 };
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
  const launch = () => chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox', '--renderer-process-limit=2'] });
  let browser = await launch();
  let pageCount = 0;
  let page; const errors = [], records = [], failures = [];
  const base = `http://127.0.0.1:${server.address().port}`;
  const resetPage = async () => {
    // Closing the owned context releases prior bundles/canvases and query caches.
    if (page) await page.context().close();
    if (++pageCount % 42 === 0) { await browser.close(); browser = await launch(); }
    page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    await page.addInitScript(() => { localStorage.setItem('selectedTradingAccountId:home-user', 'season-account'); localStorage.setItem('trading-app:appearance', 'system'); });
  };
  const id = name => page.getByTestId(name);
  const switchAccount = async accountId => {
    await id('trading-account-switcher-trigger').click(); await id(`trading-account-switcher-option-${accountId}`).click();
    await id('trading-account-switcher-sheet').waitFor({ state: 'hidden' });
  };
  const inspectCard = async () => {
    const capture = await id('home-account-context').screenshot();
    return id('home-account-context').evaluate(async (card, captureUrl) => {
    const box = card.getBoundingClientRect(); const clipped = [], overlaps = [], contrast = [];
    const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const emblem = card.querySelector('[data-testid^="home-emblem-"]') ?? card.querySelector('[data-testid="home-tier-neutral"]');
    const emblemBox = emblem.getBoundingClientRect();
    const luminance = value => { const c = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
    const rendered = new Image(); rendered.src = captureUrl; await rendered.decode();
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = rendered.naturalWidth; maskCanvas.height = rendered.naturalHeight;
    const maskContext = maskCanvas.getContext('2d'); maskContext.drawImage(rendered, 0, 0);
    const maskPixels = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    const solidBackground = luminance(getComputedStyle(card).backgroundColor);
    const artwork = card.querySelector('[data-testid="home-tier-background-artwork"]');
    const backgroundBands = [...card.querySelectorAll('[data-testid^="home-tier-background-"] > svg')];
    let pixels, sourceWidth, sourceHeight;
    if (artwork) {
      const source = new Image(); source.src = artwork.querySelector('image').getAttribute('href'); await source.decode();
      const canvas = document.createElement('canvas'); canvas.width = source.naturalWidth; canvas.height = source.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0);
      pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; sourceWidth = canvas.width; sourceHeight = canvas.height;
    }
    const backgroundAt = (x, y) => {
      if (!pixels) return solidBackground;
      const band = backgroundBands.find(svg => { const r = svg.getBoundingClientRect(); return x >= r.left - .02 && x < r.right + .02 && y >= r.top - .02 && y < r.bottom + .02; });
      if (!band) throw new Error('Text has no background band');
      const r = band.getBoundingClientRect(), v = band.viewBox.baseVal;
      const sx = Math.min(sourceWidth - 1, Math.max(0, Math.floor(v.x + (x - r.left) / r.width * v.width)));
      const sy = Math.min(sourceHeight - 1, Math.max(0, Math.floor(v.y + (y - r.top) / r.height * v.height)));
      const i = (sy * sourceWidth + sx) * 4;
      return luminance(`rgb(${pixels[i]},${pixels[i + 1]},${pixels[i + 2]})`);
    };
    const contrastFor = (rects, color) => {
      const fg = luminance(color), rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number);
      let worst = Infinity, samples = 0;
      for (const r of rects) for (let y = r.top; y < r.bottom; y += 1) for (let x = r.left; x < r.right; x += 1) {
        const ix = Math.floor(x - box.left), iy = Math.floor(y - box.top);
        const offset = (iy * maskCanvas.width + ix) * 4;
        // Only opaque glyph/stroke cores from the actual screenshot. Empty
        // line-box space and antialiased edges are not foreground pixels.
        if (!rgb.every((v, channel) => Math.abs(v - maskPixels[offset + channel]) <= 3)) continue;
        const bg = backgroundAt(box.left + ix + .5, box.top + iy + .5); samples++;
        worst = Math.min(worst, (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05));
      }
      if (samples === 0) throw new Error(`No visible foreground samples for ${color}`);
      return worst;
    };
    const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const t = walk.currentNode; if (!t.textContent.trim() || t.parentElement.closest('[aria-hidden="true"]')) continue;
      const range = document.createRange(); range.selectNodeContents(t);
      for (const r of range.getClientRects()) {
        if (r.left < box.left || r.right > box.right || r.top < box.top || r.bottom > box.bottom) clipped.push(t.textContent);
        if (r.left < emblemBox.right && r.right > emblemBox.left && r.top < emblemBox.bottom && r.bottom > emblemBox.top) overlaps.push(t.textContent);
      }
      const style = getComputedStyle(t.parentElement);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      contrast.push({ text: t.textContent, ratio: contrastFor([...range.getClientRects()], style.color), required: large ? 3 : 4.5 });
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
    const icon = button.querySelector('svg');
    const background = artwork ? { sourceWidth, sourceHeight, borderWidth: getComputedStyle(card).borderWidth,
      bands: backgroundBands.map(svg => ({ ...rect(svg), viewBox: svg.getAttribute('viewBox') })) } : null;
    return { image, background, iconContrast: contrastFor([icon.getBoundingClientRect()], getComputedStyle(icon).stroke), title: typography('[data-testid="home-account-title"]'), nickname: typography('[data-testid="home-nickname"]'), card: rect(card), emblem: rect(emblem), button: rect(button), clipped, overlaps, contrast, text: card.textContent, label: button.getAttribute('aria-label') };
    }, `data:image/png;base64,${capture.toString('base64')}`);
  };
  try {
    for (const appearance of ['light', 'dark']) for (const width of (quick ? [390] : [320, 360, 390, 430, 768, 1280])) for (const fontScale of (quick ? [1] : [1, 1.5, 2])) for (const long of (quick ? [false] : [false, true])) for (const [tier, name] of Object.entries(tiers)) {
      try {
        await resetPage();
        await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: appearance });
        await page.goto(`${base}/?tier=${tier}&fontScale=${fontScale}&long=${long ? 1 : 0}`);
        await id('home-tier').filter({ hasText: name }).waitFor(); await id('home-nickname').waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="home-account-context"] img')].every(i => i.complete && i.naturalWidth > 0));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const layout = await inspectCard();
        assert.deepEqual(layout.clipped, [], JSON.stringify({ appearance, width, fontScale, tier, layout }));
        assert.deepEqual(layout.overlaps, [], 'text must not cover the emblem');
        assert.ok(layout.contrast.every(x => x.ratio >= x.required), JSON.stringify(layout.contrast));
        assert.ok(layout.iconContrast >= 3, JSON.stringify({ appearance, tier, iconContrast: layout.iconContrast }));
        if (layout.background) {
          assert.equal(await id(`home-tier-background-${tier === 'master' ? 'whale' : tier}-${appearance}`).count(), 1);
          const bg = layout.background;
          assert.equal(bg.borderWidth, '0px', 'PNG owns the only metal rim');
          const scale = layout.card.width / bg.sourceWidth;
          assert.ok(layout.card.height + .02 >= bg.sourceHeight * scale);
          for (const band of [bg.bands[0], bg.bands.at(-1)]) {
            const v = band.viewBox.split(' ').map(Number);
            assert.ok(Math.abs(band.height - v[3] * scale) < .03, 'artwork and bottom rim keep their original ratio');
          }
          assert.ok(Math.abs(bg.bands.at(-1).bottom - layout.card.bottom) < .05, JSON.stringify({ message: 'bottom rim closes the growing card', card: layout.card, bg }));
        }
        assert.ok(layout.button.width >= 44 && layout.button.height >= 44); assert.match(layout.label, /계정 변경.*Season 1/);
        assert.ok(layout.emblem.right <= layout.card.right);
        assert.doesNotMatch(layout.text, /현재 순위|최종 순위|현재 등급|최종 등급|변경/);
        if (tier === 'null') assert.equal(await id('home-tier-image').count(), 0);
        else assert.equal(await id(`home-emblem-${tier === 'master' ? 'whale' : tier}`).count(), 1);
        if (layout.image) {
          assert.ok(Math.abs(layout.image.sx / layout.image.sy - 1) < .0002, 'uniform image scaling at the raster layout precision');
          assert.equal(layout.image.fit, 'contain');
          const index = Object.keys(tiers).indexOf(tier);
          const expected = 128 * (1 + index * .01) * optical[tier] * (width < 360 ? 132 / 160 : 1);
          assert.ok(Math.abs(layout.image.equivalentSize - expected) < .03, 'rendered size matches the visually reviewed optical adjustment');
        }
        assert.ok(layout.title.size > 16 * fontScale && layout.title.weight > 600);
        assert.ok(layout.nickname.size > 15 * fontScale && layout.nickname.weight > 600);
        if (fontScale === 1 && !long) {
          assert.ok(layout.emblem.y < layout.title.bottom, 'emblem uses the top title band');
        }
        if (width === 390 && fontScale === 1 && !long) {
          assert.ok(layout.button.y < layout.title.bottom && layout.button.bottom > layout.title.y, 'Season 1 and the 44px change button share one row for every tier');
          await id('home-account-context').screenshot({ path: path.join(out, `${tier}-${appearance}.png`) });
          if (tier === 'master') await page.screenshot({ path: path.join(out, `home-whale-${appearance}.png`) });
        }
        if (width === 320 && fontScale === 1 && !long && tier === 'diamond') await id('home-account-context').screenshot({ path: path.join(out, `narrow-diamond-${appearance}.png`) });
        if (width === 320 && fontScale === 2 && long && tier === 'master') await id('home-account-context').screenshot({ path: path.join(out, `large-text-${appearance}.png`) });
        records.push({ appearance, width, fontScale, long, tier, layout });
      } catch (error) {
        const failure = { appearance, width, fontScale, long, tier, message: String(error) };
        failures.push(failure);
        console.error(JSON.stringify(failure));
        if (failures.length <= 3) await page.screenshot({ path: path.join(out, `layout-failure-${failures.length}.png`), fullPage: true });
      }
    }
    fs.writeFileSync(path.join(out, 'layout-failures.json'), JSON.stringify(failures, null, 2));
    assert.deepEqual(failures, [], 'every layout must pass');
    for (const state of ['ranking-loading', 'ranking-error', 'ranking-unavailable', 'unranked']) {
      await resetPage();
      await page.goto(`${base}/?tier=master&state=${state}`); await id('home-tier-neutral').waitFor();
      assert.equal(await id('home-tier-image').count(), 0);
      assert.equal(await page.locator('[data-testid^="home-tier-background-"]').count(), 0);
      assert.equal(await id('home-tier').textContent(), state === 'ranking-loading' ? '티어 확인 중' : state === 'ranking-error' ? '티어 확인 실패' : '티어 미정');
      if (state === 'ranking-loading') {
        await switchAccount('general-account'); await page.evaluate(() => window.fixture.transport.release());
        await id('home-nickname').waitFor(); assert.equal(await id('home-tier').count(), 0);
      }
      records.push({ state });
    }
    await resetPage();
    await page.goto(`${base}/?tier=unknown`); await id('home-tier-neutral').waitFor(); assert.equal(await id('home-tier').textContent(), '티어 미정');
    await page.goto(`${base}/?tier=master&past=1`); await id('home-emblem-whale').waitFor();
    await switchAccount('past-account'); await id('home-emblem-diamond').waitFor(); assert.equal(await id('home-rank').textContent(), '#245');
    assert.match(await id('home-account-context').textContent(), /지난 시즌.*종료.*정산 완료/);
    const calls = await page.evaluate(() => window.fixture.transport.requests.filter(r => r.startsWith('/ranking?')));
    assert.ok(calls.some(r => /seasonId=past-season/.test(r) && /rankType=final/.test(r)));
    await switchAccount('general-account'); await id('home-nickname').waitFor(); assert.equal(await id('home-tier').count(), 0); assert.equal(await id('home-rank').count(), 0);
    await switchAccount('season-account'); await id('home-emblem-whale').waitFor(); assert.equal(await id('home-rank').textContent(), '#2');
    records.push({ scenario: 'active-past-general-active', calls });
    // Status copy uses the same background/foreground as the live card.
    for (const appearance of ['light', 'dark']) for (const tier of Object.keys(optical)) for (const state of ['closed', 'ended', 'excluded']) for (const fontScale of [1, 2]) {
      await resetPage();
      await page.setViewportSize({ width: fontScale === 1 ? 390 : 320, height: 900 });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?tier=${tier}&state=${state}&fontScale=${fontScale}`);
      await id('home-tier').filter({ hasText: tiers[tier] }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await inspectCard();
      assert.deepEqual(layout.clipped, []); assert.deepEqual(layout.overlaps, []);
      assert.ok(layout.contrast.every(c => c.ratio >= c.required), JSON.stringify({ appearance, tier, state, fontScale, contrast: layout.contrast }));
      assert.ok(layout.iconContrast >= 3);
      records.push({ scenario: 'status-copy', appearance, tier, state, fontScale, layout });
    }
    for (const tier of Object.keys(optical)) {
      await resetPage(); await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(`${base}/?tier=${tier}`);
      const visual = tier === 'master' ? 'whale' : tier;
      await id(`home-emblem-${visual}`).waitFor();
      for (const mode of ['light', 'dark', 'light']) {
        await page.evaluate(mode => window.fixture.appearance.setPreference(mode), mode);
        await id(`home-tier-background-${visual}-${mode}`).waitFor();
        assert.equal(await id(`home-tier-background-${visual}-${mode === 'light' ? 'dark' : 'light'}`).count(), 0);
      }
      records.push({ scenario: 'live-appearance', tier });
    }
    await resetPage(); await page.goto(`${base}/?tier=master&past=1&state=ranking-loading`);
    await id('home-tier-neutral').waitFor(); await switchAccount('past-account');
    assert.equal(await page.locator('[data-testid^="home-tier-background-"]').count(), 0);
    await page.waitForFunction(() => window.fixture.transport.pending.length >= 2);
    await page.evaluate(() => window.fixture.transport.release()); await id('home-emblem-diamond').waitFor();
    assert.equal(await id('home-rank').textContent(), '#245');
    assert.equal(await page.locator('[data-testid^="home-tier-background-whale-"]').count(), 0);
    await switchAccount('general-account');
    assert.equal(await page.locator('[data-testid^="home-tier-background-"]').count(), 0);
    records.push({ scenario: 'late-ranking-past-general' });
    for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width: 1122, height: 510 });
      await page.setContent(`<html><body style="margin:0;padding:18px;background:${appearance === 'light' ? '#fcfcfd' : '#15171c'};display:grid;grid-template-columns:repeat(3,358px);gap:6px">${Object.keys(tiers).filter(t => t !== 'null').map(t => `<img width="358" src="${base}/capture/${t}-${appearance}.png">`).join('')}</body></html>`);
      await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth));
      await page.screenshot({ path: path.join(out, `tiers-${appearance}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ records, errors }, null, 2));
    for (const file of ['failure.png', 'failure.json', 'layout-failure-1.png', 'layout-failure-2.png', 'layout-failure-3.png']) fs.rmSync(path.join(out, file), { force: true });
    console.log(`PASS ${records.length} layout/state/switch records`);
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: String(error), errors, completed: records.length }, null, 2)); throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
