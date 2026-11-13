// 관리자 전용 콘솔·공지 작성·공지 팝업(2026-11-13) on production RN-Web screens with long Korean
// content: 320/375/430px × font 1/2 × Light/Dark. NODE_PATH=<browser-tools>/node_modules
// BROWSER_EXECUTABLE_PATH=… ADMIN_NOTICE_FONT=<Korean .ttf> node test/browser/adminNoticeBrowser.cjs
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.ADMIN_NOTICE_OUTPUT ?? '/tmp/trading-admin-notice-ui';
const widths = [320, 375, 430], scales = [1, 2], modes = ['light', 'dark'];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const mocks = path.join(__dirname, 'adminNoticeMocks.js');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'adminNoticeFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'admin-notice-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|app\/navigation\/navigationRef)$/ }, () => ({ path: mocks }));
      b.onResolve({ filter: /^@react-navigation\/elements$/ }, args => (args.importer.includes('/screens/admin/') ? { path: mocks } : undefined));
    } }], logLevel: 'warning' });
  const font = process.env.ADMIN_NOTICE_FONT;
  const server = http.createServer((req, res) => {
    if (req.url === '/qa-font.ttf') { res.setHeader('Content-Type', 'font/ttf'); res.end(font ? fs.readFileSync(font) : ''); return; }
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}@font-face{font-family:QAKorean;src:url(/qa-font.ttf)}body *{font-family:QAKorean,sans-serif!important}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, errors = [], problems = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  let page, checked = 0;
  const id = name => page.getByTestId(name);
  const visit = async (screen, width, mode, scale, height = 740) => {
    if (page) await page.context().close();
    page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(`${screen} ${width}: ${e.message}`));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(mode => localStorage.setItem('trading-app:appearance', mode), mode);
    await page.goto(`${base}/?screen=${screen}&fontScale=${scale}`);
    await id({ popup: 'notice-popup', list: 'admin-notices-screen', editor: 'admin-notice-editor', console: 'admin-console-screen' }[screen]).waitFor({ timeout: 10_000 });
    if (font) await page.evaluate(() => document.fonts.load('16px QAKorean', '공지사항'));
  };
  const inspect = (mutate = null) => page.evaluate(mutate => {
    const found = [];
    if (mutate) for (const el of document.querySelectorAll(mutate)) Object.assign(el.style, { whiteSpace: 'nowrap', fontSize: '40px' });
    const width = document.documentElement.clientWidth;
    if (document.scrollingElement.scrollWidth > width + 1) found.push(`page scrolls sideways (${document.scrollingElement.scrollWidth} > ${width})`);
    const hidden = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (e.getAttribute('aria-hidden') === 'true' || s.opacity === '0' || s.display === 'none' || s.visibility === 'hidden') return true; } return false; };
    const boxOf = el => { for (let e = el.parentElement; e; e = e.parentElement) if (parseFloat(getComputedStyle(e).borderLeftWidth) > 0) return e; return null; };
    const cut = value => value === 'hidden' || value === 'clip';
    const clipsOf = el => { const list = []; for (let e = el.parentElement; e; e = e.parentElement) { const s = getComputedStyle(e); if (cut(s.overflowX) || cut(s.overflowY)) list.push({ rect: e.getBoundingClientRect(), x: cut(s.overflowX), y: cut(s.overflowY) }); } return list; };
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), range = document.createRange();
    while (walk.nextNode()) {
      const node = walk.currentNode, el = node.parentElement;
      if (!node.textContent.trim() || !el || hidden(el) || el.closest('svg') || el.closest('input,textarea')) continue;
      const box = boxOf(el)?.getBoundingClientRect(), clips = clipsOf(el);
      for (let i = 0; i < node.length; i++) {
        if (!node.textContent[i].trim()) continue;
        range.setStart(node, i); range.setEnd(node, i + 1);
        for (const r of range.getClientRects()) {
          const bad = r.left < -0.5 || r.right > width + 0.5 ||
            (box && (r.left < box.left - 0.5 || r.right > box.right + 0.5)) ||
            clips.some(({ rect: c, x, y }) => (x && (r.left < c.left - 0.5 || r.right > c.right + 0.5)) || (y && (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5)));
          if (bad) { found.push(`clipped "${node.textContent.slice(Math.max(0, i - 6), i + 6)}"`); i = node.length; break; }
        }
      }
    }
    return found;
  }, mutate);
  const hittable = async testId => {
    const el = id(testId).first();
    await el.scrollIntoViewIfNeeded();
    return el.evaluate(node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && node.contains(hit) && r.top >= 0 && r.bottom <= innerHeight; });
  };
  const record = async (label, extra = []) => {
    const found = [...(await inspect()), ...extra];
    checked++;
    if (found.length) problems.push(`${label}: ${[...new Set(found)].slice(0, 6).join(' | ')}`);
  };
  const longBody = Array.from({ length: 6 }, (_, i) => `${i + 1}번째 문단입니다. 점검 시간에는 주문 접수와 체결, 환전과 이체가 일시적으로 중지되며 점검이 끝나면 자동으로 다시 열립니다.\n줄바꿈도 그대로 보입니다.`).join('\n\n') + '\n\n## 영향 범위\n국내·미국 주식과 암호화폐 현물·선물 전부';

  await visit('popup', 320, 'light', 2);
  assert.ok((await inspect('[data-testid="notice-popup-card"] *')).length > 0, 'glyph detector negative control');

  for (const width of widths) for (const scale of scales) for (const mode of modes) {
    const label = `${width}px ${scale}x ${mode}`;
    // The popup: centered, inside the screen, both buttons reachable, text never cut (it scrolls inside the card).
    await visit('popup', width, mode, scale, scale === 2 ? 568 : 740);
    const card = await id('notice-popup-card').boundingBox();
    const extra = [];
    if (card.x < 0 || card.y < 0 || card.x + card.width > width + 0.5 || card.y + card.height > (scale === 2 ? 568 : 740) + 0.5) extra.push('card outside the screen');
    for (const testId of ['notice-popup-detail', 'notice-popup-confirm']) if (!(await hittable(testId))) extra.push(`${testId} not reachable`);
    if (await page.getByTestId('behind').evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.left + 5, r.top + 5)); })) extra.push('the screen behind is still touchable');
    await record(`popup ${label}`, extra);
    await visit('list', width, mode, scale);
    await id('admin-notice-n-2-preview').click();
    await id('admin-notice-n-1-publish').click();
    await record(`list ${label}`, (await hittable('admin-notice-n-1-confirm-submit')) ? [] : ['confirm button not reachable']);
    await visit('editor', width, mode, scale);
    await id('admin-notice-title').fill('11월 20일(목) 새벽 2시부터 3시까지 정기 서버 점검 및 주문 시스템 개선 작업 안내 공지');
    await id('admin-notice-summary').fill('점검 시간에는 주문 접수와 체결, 환전과 이체가 일시적으로 중지됩니다. 점검이 끝나면 자동으로 다시 열립니다.');
    await id('admin-notice-body').fill(longBody);
    await id('admin-notice-popup').click();
    await id('admin-notice-preview').click();
    await id('admin-notice-publish').click();
    await record(`editor ${label}`, (await hittable('admin-notice-confirm-submit')) ? [] : ['confirm not reachable']);
    await visit('console', width, mode, scale);
    await record(`console ${label}`);
  }
  // Behaviour: 확인 records the confirmation and closes the popup.
  await visit('popup', 375, 'light', 1);
  await page.screenshot({ path: path.join(out, 'popup-375.png') });
  await id('notice-popup-confirm').click();
  await page.waitForFunction(() => window.adminRequests.some(([method, url]) => method === 'POST' && url === '/notices/n-2/acknowledgement'));
  assert.equal(await page.getByTestId('notice-popup').count(), 0);
  await visit('editor', 320, 'dark', 2);
  await id('admin-notice-title').fill('점검 안내');
  await id('admin-notice-summary').fill('새벽 점검');
  await id('admin-notice-body').fill(longBody);
  await id('admin-notice-popup').click();
  await id('admin-notice-preview').click();
  await page.screenshot({ path: path.join(out, 'editor-320-2x-dark.png'), fullPage: true });
  await browser.close(); server.close();
  console.log(`${checked} layouts checked`);
  if (errors.length) console.log(`page errors:\n${[...new Set(errors)].join('\n')}`);
  if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; }
  else if (!errors.length) console.log('admin notice browser ok');
  else process.exitCode = 1;
})().catch(error => { console.error(error); process.exit(1); });
