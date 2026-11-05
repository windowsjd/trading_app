// Optional real RN Web check of 유저 시즌 요약 (2026-11-06): the ranking tab's tier card for
// the selected user and the friend action under it, at 320/360/390/430px, light/dark and
// 1x/1.5x/2x fonts — tiers (Bronze, Whale, none: the plain card) with a long nickname and long
// figures, every relationship state, the request/accept flow and the member's own summary.
// Glyphs never leave the card or the screen, the action sits below the card with 44px
// buttons, and a deliberately broken layout proves the detector fires. Requires external
// esbuild and Playwright (see README); USER_SUMMARY_QUICK=1 checks 320 dark 2x and 390 light 1x only.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.USER_SUMMARY_BROWSER_OUTPUT ?? '/tmp/trading-user-summary-browser';

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'userSummaryFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'user-summary-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks)$/ }, () => ({ path: path.join(__dirname, 'userSummaryMocks.js') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  const errors = [];
  let checked = 0;
  try {
    const quick = process.env.USER_SUMMARY_QUICK === '1';
    const layouts = [];
    for (const width of [320, 360, 390, 430]) for (const mode of ['light', 'dark']) for (const fontScale of [1, 1.5, 2]) layouts.push([width, mode, fontScale]);
    for (const [width, mode, fontScale] of quick ? [[320, 'dark', 2], [390, 'light', 1]] : layouts) {
      const page = await browser.newPage({ viewport: { width, height: 1400 }, reducedMotion: 'reduce' });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
      await page.addInitScript((appearance) => localStorage.setItem('trading-app:appearance', appearance), mode);
      const tag = `${width}-${mode}-${fontScale}x`;
      const go = async (query) => {
        await page.goto(`${base}/?fontScale=${fontScale}&${query}`);
        await page.getByTestId('user-summary-card').waitFor();
        if (await page.getByTestId('user-summary-tier').count())
          await page.locator('[data-testid="home-tier-background-artwork"] image').waitFor({ state: 'attached' });
        await page.evaluate(async () => {
          await Promise.all([...document.querySelectorAll('svg image')].map((image) => {
            const im = new Image(); im.src = image.getAttribute('href') ?? image.getAttribute('xlink:href'); return im.decode().catch(() => {});
          }));
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
      };
      // Problems as short strings: glyphs outside the card / action / screen, the action
      // above or over the card, short buttons, sideways scrolling. `mutation` breaks the card.
      const inspect = (mutation = null) => page.evaluate((mutation) => {
        const rect = (el) => el.getBoundingClientRect();
        const glyphs = (el) => {
          const found = [], range = document.createRange(), walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          while (walk.nextNode()) for (let i = 0; i < walk.currentNode.length; i++) {
            if (!walk.currentNode.textContent[i].trim()) continue;
            range.setStart(walk.currentNode, i); range.setEnd(walk.currentNode, i + 1); found.push(...range.getClientRects());
          }
          return found;
        };
        const inside = (a, b) => a.left >= b.left - .5 && a.right <= b.right + .5 && a.top >= b.top - .5 && a.bottom <= b.bottom + .5;
        const card = document.querySelector('[data-testid="user-summary-card"]');
        const friend = document.querySelector('[data-testid="user-summary-friend"]');
        const undo = [];
        if (mutation === 'clip') {
          const name = document.querySelector('[data-testid="user-summary-nickname"]');
          const before = name.getAttribute('style');
          undo.push(() => (before === null ? name.removeAttribute('style') : name.setAttribute('style', before)));
          Object.assign(name.style, { whiteSpace: 'nowrap', fontSize: '60px' });
        }
        const problems = [];
        try {
          const k = rect(card);
          if (glyphs(card).some((g) => !inside(g, k) || g.right > innerWidth + .5)) problems.push('card text clipped');
          if (friend) {
            const f = rect(friend);
            if (f.top < k.bottom - .5) problems.push('action over the card');
            if (glyphs(friend).some((g) => g.left < -.5 || g.right > innerWidth + .5 || !inside(g, f))) problems.push('action text clipped');
            for (const button of friend.querySelectorAll('[role="button"]')) if (rect(button).height < 44 - .5) problems.push('button under 44px');
          }
          if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('page scrolls sideways');
        } finally {
          undo.forEach((fn) => fn());
        }
        return problems;
      }, mutation);
      const text = (id) => page.getByTestId(id).innerText();
      const shot = async (name) => {
        await page.waitForTimeout(150);
        const box = await page.getByTestId('user-summary-card').boundingBox();
        const friend = page.getByTestId('user-summary-friend');
        const bottom = (await friend.count()) ? (await friend.boundingBox()).y + (await friend.boundingBox()).height : box.y + box.height;
        await page.screenshot({ path: path.join(out, `${name}-${tag}.png`), clip: { x: 0, y: 0, width, height: Math.min(1400, bottom + 16) } });
      };

      // The tier card of the SELECTED user: its art, emblem, 시즌 순위 and figures; the plain card without a tier.
      for (const tier of ['bronze', 'master', 'none']) for (const long of [false, true]) {
        const name = `${tier}${long ? '-long' : ''}-received`;
        await go(`tier=${tier}&rel=received${long ? '&long=1' : ''}`);
        const card = await text('user-summary-card');
        assert.ok(card.includes('시즌 순위') && !card.includes('내 순위') && !card.includes('나의닉네임'), `${name} card words (${tag})`);
        assert.equal(await text('user-summary-nickname'), long ? '아주긴닉네임대한민국LongNickname'.repeat(2) : '브론즈트레이더', `${name} nickname (${tag})`);
        if (tier === 'none') {
          assert.deepEqual([await page.getByTestId('user-summary-tier').count(), await page.locator('[data-testid^="home-tier-background-"]').count()], [0, 0], `${name} plain card (${tag})`);
          assert.deepEqual([await text('user-summary-rank'), await text('user-summary-return'), await text('user-summary-total')], ['-', '-', '-'], `${name} no figures (${tag})`);
        } else {
          assert.equal(await text('user-summary-tier'), tier === 'master' ? 'Whale' : 'Bronze', `${name} tier (${tag})`);
          const inCard = async (selector) => page.getByTestId('user-summary-card').locator(selector).count();
          assert.ok(await inCard(`[data-testid="home-tier-background-${tier === 'master' ? 'whale' : 'bronze'}-${mode}"]`) === 1, `${name} tier art (${tag})`);
          assert.ok(await inCard(`[data-testid="home-emblem-${tier === 'master' ? 'whale' : 'bronze'}"]`) >= 1, `${name} emblem (${tag})`);
          assert.equal(await text('user-summary-total'), long ? '1,234,567,890,123,456원' : '10,450,000원', `${name} total (${tag})`);
        }
        assert.ok((await text('user-summary-friend')).includes('친구 요청을 보냈어요.'), `${name} received (${tag})`);
        assert.deepEqual(await inspect(), [], `${name} layout (${tag})`);
        await shot(name);
        checked++;
      }
      // The detector itself: a nickname forced past the card is reported.
      await go('tier=bronze&rel=received&long=1');
      assert.ok((await inspect('clip')).includes('card text clipped'), `the clip detector fires (${tag})`);
      assert.deepEqual(await inspect(), [], `restored (${tag})`);

      // Every relationship state reads as the server says; a failed read is never 친구 요청.
      for (const [rel, expected] of [['none', '친구 요청'], ['sent', '요청 보냄 · 수락 대기 중'], ['friend', '친구'], ['error', '친구 관계를 확인하지 못했어요. 다시 시도해 주세요.']]) {
        await go(`tier=bronze&rel=${rel}&long=1`);
        await page.getByTestId(rel === 'none' ? 'user-summary-friend-request' : rel === 'sent' ? 'user-summary-friend-sent'
          : rel === 'friend' ? 'user-summary-friend-friend' : 'user-summary-friend-unknown').waitFor();
        const action = await text('user-summary-friend');
        assert.ok(action.includes(expected), `${rel} copy (${tag})`);
        if (rel === 'error') assert.deepEqual([await page.getByTestId('user-summary-friend-request').count(), await page.getByTestId('user-summary-friend-retry').count()], [0, 1], `error retry (${tag})`);
        assert.deepEqual(await inspect(), [], `${rel} layout (${tag})`);
        await shot(`state-${rel}`);
        checked++;
      }

      // 친구 요청: a double click sends once, shows its busy state, then 요청 보냄.
      await go('tier=bronze&rel=none');
      await page.getByTestId('user-summary-friend-request').dblclick();
      await page.getByText('요청 중...', { exact: true }).waitFor();
      await page.getByTestId('user-summary-friend-sent').waitFor();
      assert.equal(await page.evaluate(() => window.fixture.transport.requests.filter((request) => request === 'POST /friends/requests').length), 1, `one request (${tag})`);
      // 수락: friend, and the summary is read again for its permission.
      await go('tier=bronze&rel=received');
      const reads = await page.evaluate(() => window.fixture.transport.requests.filter((request) => request === 'GET /users/target/season-summary').length);
      await page.getByTestId('user-summary-friend-accept').click();
      await page.getByTestId('user-summary-friend-friend').waitFor();
      assert.ok(await page.evaluate(() => window.fixture.transport.requests.filter((request) => request === 'GET /users/target/season-summary').length) > reads, `summary read again (${tag})`);
      await shot('accepted');
      // The member's own summary: the card, no friend action, no relationship read.
      await go('tier=bronze&self=1');
      assert.deepEqual([await page.getByTestId('user-summary-friend').count(),
        await page.evaluate(() => window.fixture.transport.requests.some((request) => request.startsWith('GET /friends/relationships/')))], [0, false], `self (${tag})`);
      assert.deepEqual(await inspect(), [], `self layout (${tag})`);
      await shot('self');
      checked += 3;
      await page.close();
    }
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`user summary browser: ${checked} screens checked, screenshots in ${out}`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
