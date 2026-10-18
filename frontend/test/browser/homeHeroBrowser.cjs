// Home total assets beside the season tier emblem (HomeAssetHero + heroTotalFit) on the real
// Home screen, queries and emblems; only HTTP and navigation are mocked. Every combination of
// 320/360/390/430 dp × font scale 1/1.3/2 × six tiers × amounts of 7–16 digits × light/dark must
// keep the total on one line and every hero text inside the card and off the emblem. Records
// where the emblem sits (beside, or below at large text) and the total's size. An amount
// update must not move the emblem or wrap the total in any frame. Requires esbuild and
// Playwright (see README); RN-Web only — not a device check.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const assert = require('node:assert/strict'), esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.HOME_HERO_BROWSER_OUTPUT ?? '/tmp/trading-home-hero';
const quick = process.env.HOME_HERO_QUICK === '1';
const tiers = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master'];
const amounts = ['9648192', '10450000', '123456789', '1234567890', '1234567890123456'];

/** In page: the hero card's geometry and every text problem in it. */
function measure() {
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const card = q('home-summary-card'), total = q('home-total-asset'), aside = q('home-hero-aside');
  if (!card || !total) return null;
  const range = document.createRange(); range.selectNodeContents(total);
  const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
  const c = box(card), t = box(total), emblem = aside ? box(aside) : null, issues = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || node.parentElement.closest('[aria-hidden="true"]') || aside?.contains(node.parentElement)) continue;
    for (const word of node.textContent.matchAll(/\S+/gu)) {
      const part = document.createRange(); part.setStart(node, word.index); part.setEnd(node, word.index + word[0].length);
      for (const r of part.getClientRects()) {
        if (r.left < c.x - 0.5 || r.right > c.right + 0.5) issues.push(`clipped ${word[0]}`);
        if (emblem && r.left < emblem.right && r.right > emblem.x && r.top < emblem.bottom && r.bottom > emblem.y) issues.push(`over emblem ${word[0]}`);
      }
    }
  }
  if (emblem && (emblem.right > c.right + 0.5 || emblem.x < c.x - 0.5)) issues.push('emblem outside the card');
  return { card: c, total: t, emblem, lines, issues, fontSize: parseFloat(getComputedStyle(total).fontSize),
    beside: !!emblem && emblem.y < t.bottom && emblem.x >= t.right - 1 };
}

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
    const bundle = req.url === '/bundle.js';
    res.setHeader('Content-Type', bundle ? 'text/javascript' : 'text/html');
    res.end(bundle ? fs.readFileSync(path.join(out, 'bundle.js')) : html);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  const records = [], failures = [], errors = [];
  /** Waits until the fit has converged: the same size and line count for five frames. */
  const settle = (page) => page.evaluate(async (source) => {
    const read = new Function(`return (${source})()`);
    let last = '', same = 0;
    for (let frame = 0; frame < 240 && same < 5; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const m = read();
      const key = m ? `${m.fontSize}|${m.lines}|${m.emblem ? Math.round(m.emblem.x) : '-'}` : '';
      same = key && key === last ? same + 1 : 0; last = key;
    }
    return read();
  }, measure.toString());
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => { localStorage.setItem('selectedTradingAccountId:home-user', 'season-account'); localStorage.setItem('trading-app:appearance', 'system'); });
    for (const appearance of quick ? ['light'] : ['light', 'dark'])
      for (const width of quick ? [320, 390] : [320, 360, 390, 430])
        for (const fontScale of quick ? [1, 2] : [1, 1.3, 2])
          for (const tier of quick ? ['diamond', 'master'] : tiers)
            for (const total of quick ? ['10450000', '1234567890123456'] : amounts) {
              const tag = { appearance, width, fontScale, tier, total };
              try {
                await page.setViewportSize({ width, height: 900 });
                await page.emulateMedia({ colorScheme: appearance });
                await page.goto(`${base}/?tier=${tier}&fontScale=${fontScale}&total=${total}`);
                await page.getByTestId('home-total-asset').waitFor();
                await page.getByTestId('home-hero-aside').waitFor();
                const m = await settle(page);
                assert.deepEqual(m.issues, []);
                assert.ok(m.fontSize >= 18 * fontScale - 0.01, `never below the 총 자산 label (${m.fontSize})`);
                // One line, except an amount that cannot fit the whole row even at the minimum
                // size: then (by design) it breaks there with the emblem below, never cut or overlapped.
                if (m.lines !== 1) {
                  assert.ok(!m.beside && Math.abs(m.fontSize - 18 * fontScale) < 0.01, `wrapped above the minimum or beside the emblem (${m.fontSize})`);
                }
                records.push({ ...tag, beside: m.beside, lines: m.lines, fontSize: m.fontSize, scaled: +(m.fontSize / fontScale).toFixed(2) });
                if (width === 320 && total === '1234567890123456' && (tier === 'master' || tier === 'diamond'))
                  await page.getByTestId('home-summary-card').screenshot({ path: path.join(out, `hero-${appearance}-${width}-${fontScale}x-${tier}-long.png`) });
              } catch (error) {
                failures.push({ ...tag, message: String(error).slice(0, 300) });
              }
            }
    // First appearance: before its widths are measured the total is drawn at the base size
    // (the intended layout), so a long amount can show on two lines for a frame or two
    // while appearing. Recorded, and bounded so a slower settle is caught.
    for (const [width, fontScale] of quick ? [[320, 1]] : [[320, 1], [390, 1], [360, 1.3], [430, 1.3]])
      for (const tier of quick ? ['master'] : ['gold', 'master'])
        for (const total of ['10450000', '123456789']) {
          const tag = { mount: total, width, fontScale, tier };
          try {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`${base}/?tier=${tier}&fontScale=${fontScale}&total=${total}`);
            const frames = await page.evaluate(async (source) => {
              const read = new Function(`return (${source})()`);
              for (let wait = 0; wait < 600 && !read(); wait += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
              const seen = [];
              for (let frame = 0; frame < 60; frame += 1) {
                const m = read();
                if (m) seen.push(m.lines);
                await new Promise((resolve) => requestAnimationFrame(resolve));
              }
              return seen;
            }, measure.toString());
            const settled = await settle(page);
            const wrappedFrames = frames.findIndex((lines) => lines === 1);
            if (settled.lines === 1) assert.ok(wrappedFrames >= 0 && wrappedFrames <= 3, `settles within 3 frames: ${JSON.stringify(frames.slice(0, 8))}`);
            records.push({ ...tag, wrappedFrames });
          } catch (error) {
            failures.push({ ...tag, message: String(error).slice(0, 300) });
          }
        }
    // An amount update in place: the emblem never moves and the total never wraps, in any frame.
    for (const [width, fontScale] of quick ? [[390, 1]] : [[320, 1], [390, 1], [430, 1], [360, 1.3], [390, 2]])
      for (const tier of quick ? ['master'] : ['gold', 'master'])
        for (const [from, to] of [['9648192', '9876543'], ['9999999', '10000000'], ['99999999', '100000000'], ['9648192', '123456789'],
          ['123456789', '1234567890123456'], ['1234567890123456', '9648192']]) {
          const tag = { update: `${from}->${to}`, width, fontScale, tier };
          try {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => { delete globalThis.__heroTotal; });
            await page.goto(`${base}/?tier=${tier}&fontScale=${fontScale}&total=${from}`);
            await page.getByTestId('home-total-asset').waitFor();
            const before = await settle(page);
            const frames = await page.evaluate(async ({ source, amount }) => {
              const read = new Function(`return (${source})()`);
              globalThis.__heroTotal = amount;
              const done = window.fixture.client.refetchQueries({ type: 'active' });
              const seen = [];
              for (let frame = 0; frame < 90; frame += 1) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
                const m = read();
                if (m) seen.push({ lines: m.lines, emblem: m.emblem && [Math.round(m.emblem.x), Math.round(m.emblem.y)], text: document.querySelector('[data-testid="home-total-asset"]').textContent, height: Math.round(m.card.height) });
              }
              await done;
              return seen;
            }, { source: measure.toString(), amount: to });
            const after = await settle(page);
            const updated = frames.filter((frame) => frame.text.replace(/[^0-9]/gu, '') === to);
            assert.ok(updated.length > 0, 'the new amount was drawn');
            // A total that settles on one line is never drawn on two in between.
            if (after.lines === 1)
              assert.ok(frames.every((frame) => frame.lines === 1), `wrapped in a frame: ${JSON.stringify(frames.filter((frame) => frame.lines !== 1).slice(0, 2))}`);
            if (before.beside && after.beside)
              assert.ok(frames.every((frame) => frame.emblem && frame.emblem[0] === Math.round(before.emblem.x) && frame.emblem[1] === Math.round(before.emblem.y)),
                'the emblem keeps its place');
            records.push({ ...tag, beforeBeside: before.beside, afterBeside: after.beside, heights: [...new Set(frames.map((frame) => frame.height))] });
          } catch (error) {
            failures.push({ ...tag, message: String(error).slice(0, 300) });
          }
        }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ records, failures, errors }, null, 2));
  const below = records.filter((record) => record.beside === false);
  const wrapped = records.filter((record) => record.lines > 1);
  const appearing = Math.max(0, ...records.filter((record) => record.mount).map((record) => record.wrappedFrames));
  console.log(`home hero browser: ${records.length} layouts, ${failures.length} failures, emblem below the total in ${below.length}, `
    + `total on two lines at the minimum size in ${wrapped.length}, at most ${appearing} frame(s) on two lines while appearing`);
  assert.deepEqual(errors, [], 'page errors');
  assert.deepEqual(failures, [], 'every layout must pass');
})().catch((error) => { console.error(error); process.exitCode = 1; });
