// Optional real RN Web check of the 친구 요청 in-app banner (2026-11-06) at 320/360/390/430px,
// light/dark and 1x/1.5x/2x fonts: pending requests at the first read stay quiet, a new one
// (long nickname, or three at once) shows 친구 요청 / …님이 친구 요청을 보냈어요. with every glyph
// inside its card and the screen, and 받은 요청 보기 opens 친구 > 받은 요청. Requires external
// esbuild and Playwright (see README); FRIEND_BANNER_QUICK=1 checks 320 dark 2x and 390 light 1x only.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.FRIEND_BANNER_BROWSER_OUTPUT ?? '/tmp/trading-friend-banner-browser';
const mocks = path.join(__dirname, 'friendRequestBannerMocks.js');

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'friendRequestBannerFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'friend-banner-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|notifications\/PushNotificationsHost|navigation\/navigationRef|quest\/questNavigationGuard)$/ }, () => ({ path: mocks }));
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
    const quick = process.env.FRIEND_BANNER_QUICK === '1';
    const layouts = [];
    for (const width of [320, 360, 390, 430]) for (const mode of ['light', 'dark']) for (const fontScale of [1, 1.5, 2]) layouts.push([width, mode, fontScale]);
    for (const [width, mode, fontScale] of quick ? [[320, 'dark', 2], [390, 'light', 1]] : layouts) {
      const tag = `${width}-${mode}-${fontScale}x`;
      for (const [name, incoming, detail] of [
        ['long', [['new', '아주긴닉네임대한민국LongNickname'.repeat(2)]], `${'아주긴닉네임대한민국LongNickname'.repeat(2)}님이 친구 요청을 보냈어요.`],
        ['burst', [['c', '셋째'], ['b', '둘째'], ['a', '첫째']], '첫째님 외 2명이 친구 요청을 보냈어요.'],
      ]) {
        const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: 'reduce' });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
        await page.addInitScript((appearance) => localStorage.setItem('trading-app:appearance', appearance), mode);
        // The first read: one request already pending stays quiet, also on a later read.
        await page.goto(`${base}/?fontScale=${fontScale}&seed=1`);
        await page.waitForFunction(() => window.fixture.requests.filter((path) => path.startsWith('/friends/requests?')).length >= 1);
        await page.evaluate(() => window.fixture.client.invalidateQueries({ queryKey: ['friends', 'requests', 'infinite'] }));
        await page.waitForTimeout(300);
        assert.equal(await page.getByTestId('friend-request-banner').count(), 0, `baseline is quiet (${tag})`);
        // New ones while in use.
        await page.evaluate((rows) => {
          window.fixture.incoming = [...rows.map(([id, nickname]) => ({ userId: `u-${id}`, nickname, profileImageUrl: null, relationship: 'received', requestId: `r-${id}` })), ...window.fixture.incoming];
          return window.fixture.client.invalidateQueries({ queryKey: ['friends', 'requests', 'infinite'] });
        }, incoming);
        await page.getByTestId('friend-request-banner').waitFor();
        assert.equal(await page.getByTestId('friend-request-banner-title').innerText(), '친구 요청', `title (${tag})`);
        assert.equal(await page.getByTestId('friend-request-banner-detail').innerText(), detail, `${name} detail (${tag})`);
        const problems = await page.evaluate(() => {
          const card = document.querySelector('[data-testid="friend-request-banner"]').getBoundingClientRect();
          const found = [], range = document.createRange(), walk = document.createTreeWalker(document.querySelector('[data-testid="friend-request-banner"]'), NodeFilter.SHOW_TEXT);
          while (walk.nextNode()) for (let i = 0; i < walk.currentNode.length; i++) {
            if (!walk.currentNode.textContent[i].trim()) continue;
            range.setStart(walk.currentNode, i); range.setEnd(walk.currentNode, i + 1);
            for (const g of range.getClientRects()) if (g.left < card.left - .5 || g.right > card.right + .5 || g.top < card.top - .5 || g.bottom > card.bottom + .5 || g.right > innerWidth + .5) found.push('glyph outside');
          }
          const button = document.querySelector('[data-testid="friend-request-banner-open"]').getBoundingClientRect();
          if (button.right > card.right + .5 || button.bottom > card.bottom + .5) found.push('action outside');
          if (card.left < 0 || card.right > innerWidth + .5) found.push('card off screen');
          if (document.documentElement.scrollWidth > innerWidth + 1) found.push('page scrolls sideways');
          return [...new Set(found)];
        });
        assert.deepEqual(problems, [], `${name} layout (${tag})`);
        await page.screenshot({ path: path.join(out, `${name}-${tag}.png`), clip: { x: 0, y: 0, width, height: 400 } });
        await page.getByTestId('friend-request-banner-open').click();
        await page.getByTestId('friend-request-banner').waitFor({ state: 'detached' });
        assert.deepEqual(await page.evaluate(() => window.fixture.navigations), [{ kind: 'friend_requests', type: 'friend_request', uid: 'viewer' }], `opens 받은 요청 (${tag})`);
        checked++;
        await page.close();
      }
    }
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`friend request banner browser: ${checked} banners checked, screenshots in ${out}`);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
