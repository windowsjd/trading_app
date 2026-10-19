// Real MembershipDeletionScreen (안내 → 본인 확인 → 최종 확인, errors,
// sending, unknown result) and MembershipDeletionResultScreen on RN-Web with a
// fixture transport: 320/375/430 dp, light/dark, font scale 1/2, plus a
// keyboard-height viewport. Checks every glyph stays inside its card and the
// viewport, nothing is clipped by an overflow:hidden box and every action is
// hit-testable. A self-test proves the detector fires.
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.MEMBERSHIP_DELETION_BROWSER_OUTPUT ?? '/tmp/trading-membership-deletion';
const widths = process.env.MEMBERSHIP_DELETION_BROWSER_WIDTHS?.split(',').map(Number) ?? [320, 375, 430];
const scales = [1, 2], modes = ['light', 'dark'];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const mocks = path.join(__dirname, 'membershipDeletionMocks.js');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'membershipDeletionFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'membership-deletion-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|features\/auth\/session|app\/navigation\/navigationRef|tradingAccount\/selectionStorage)$/ }, () => ({ path: mocks }));
      b.onResolve({ filter: /^@react-navigation\/elements$/ }, () => ({ path: mocks }));
    } }], logLevel: 'warning' });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, errors = [], problems = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  let page, checked = 0;
  const id = name => page.getByTestId(name);
  const visit = async (query, width, mode, height = 900) => {
    if (page) await page.context().close();
    page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(`${query} ${width} ${mode}: ${e.message}`));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(mode => localStorage.setItem('trading-app:appearance', mode), mode);
    await page.goto(`${base}/?${query}`);
  };
  // Every non-space glyph: inside the viewport, inside its nearest bordered
  // box, not cut by an overflow:hidden ancestor. `mutate` breaks it on purpose.
  const inspect = (mutate = null) => page.evaluate(mutate => {
    const found = [];
    if (mutate) for (const el of document.querySelectorAll(mutate)) Object.assign(el.style, { whiteSpace: 'nowrap', fontSize: '40px' });
    const width = document.documentElement.clientWidth;
    if (document.scrollingElement.scrollWidth > width + 1) found.push(`page scrolls sideways (${document.scrollingElement.scrollWidth} > ${width})`);
    const hidden = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (e.getAttribute('aria-hidden') === 'true' || s.opacity === '0' || s.display === 'none' || s.visibility === 'hidden') return true; } return false; };
    const boxOf = el => { for (let e = el.parentElement; e; e = e.parentElement) if (parseFloat(getComputedStyle(e).borderLeftWidth) > 0) return e; return null; };
    // Per axis: a scroll view (overflow-y auto) clips sideways only.
    const cut = value => value === 'hidden' || value === 'clip';
    const clipsOf = el => { const list = []; for (let e = el.parentElement; e; e = e.parentElement) { const s = getComputedStyle(e); if (cut(s.overflowX) || cut(s.overflowY)) list.push({ rect: e.getBoundingClientRect(), x: cut(s.overflowX), y: cut(s.overflowY) }); } return list; };
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), range = document.createRange();
    while (walk.nextNode()) {
      const node = walk.currentNode, el = node.parentElement;
      if (!node.textContent.trim() || !el || hidden(el) || el.closest('svg')) continue;
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
  const reachable = async testId => {
    const el = id(testId);
    await el.scrollIntoViewIfNeeded();
    return el.evaluate(node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && node.contains(hit); });
  };
  const reach = async (...ids) => { const missing = []; for (const testId of ids) if (!(await reachable(testId))) missing.push(`${testId} covered`); return missing; };
  const record = async (label, extra = []) => {
    const found = [...(await inspect()), ...extra];
    checked++;
    if (found.length) problems.push(`${label}: ${[...new Set(found)].slice(0, 6).join(' | ')}`);
  };
  const toVerify = async () => {
    await id('membership-deletion-notice').waitFor();
    await id('membership-deletion-acknowledge').click();
    await id('membership-deletion-next').click();
    await id('membership-deletion-verify').waitFor();
  };
  const toConfirm = async () => {
    await toVerify();
    await id('membership-deletion-password').fill('fixture-password');
    await id('membership-deletion-verify-submit').click();
    await id('membership-deletion-confirm').waitFor();
  };

  // Self-test: forced nowrap + huge text in the notice must be reported.
  await visit('', 320, 'light');
  await id('membership-deletion-notice').waitFor();
  assert.ok((await inspect('[data-testid="membership-deletion-notice"] [dir="auto"]')).some(p => p.startsWith('clipped') || p.startsWith('page')), 'detector self-test');

  for (const width of widths) for (const mode of modes) for (const scale of scales) {
    const label = `${width}/${mode}/${scale}x`;
    const shot = name => page.screenshot({ path: path.join(out, `${name}-${label.replaceAll('/', '-')}.png`), fullPage: true });
    const keyShots = width === 320 && scale === 2;
    await visit(`fontScale=${scale}`, width, mode);
    await id('membership-deletion-notice').waitFor();
    assert.equal(await id('membership-deletion-next').getAttribute('aria-disabled'), 'true', '다음 needs the acknowledgement');
    await record(`${label} notice`, await reach('membership-deletion-acknowledge'));
    if (keyShots) await shot('notice');
    await id('membership-deletion-acknowledge').click();
    // Disabled RN-Web pressables take no pointer events: probe once enabled.
    await record(`${label} notice acknowledged`, await reach('membership-deletion-next'));
    await id('membership-deletion-next').click();
    await id('membership-deletion-verify').waitFor();
    await id('membership-deletion-password').fill('fixture-password');
    await record(`${label} verify`, await reach('membership-deletion-password', 'membership-deletion-verify-submit', 'membership-deletion-back'));
    await id('membership-deletion-verify-submit').click();
    await id('membership-deletion-confirm').waitFor();
    await record(`${label} confirm`, await reach('membership-deletion-submit', 'membership-deletion-cancel'));
    if (keyShots) await shot('confirm');
    // Keyboard-height viewport: the focused field and 확인 stay reachable.
    await visit(`fontScale=${scale}`, width, mode, 420);
    await toVerify();
    await id('membership-deletion-password').fill('fixture-password');
    await id('membership-deletion-password').focus();
    await record(`${label} verify short viewport`, await reach('membership-deletion-password', 'membership-deletion-verify-submit'));
    // Refusals at 본인 확인 (wrong password; operator account).
    for (const check of ['fail', 'role']) {
      await visit(`check=${check}&fontScale=${scale}`, width, mode);
      await toVerify();
      await id('membership-deletion-password').fill('fixture-password');
      await id('membership-deletion-verify-submit').click();
      await id('membership-deletion-error').waitFor();
      assert.equal(await id('membership-deletion-confirm').count(), 0, 'a refusal never reaches the final step');
      await record(`${label} verify ${check}`);
      if (keyShots) await shot(`verify-${check}`);
      // A wrong password empties the field; the retry is reachable once typed.
      await id('membership-deletion-password').fill('fixture-password-2');
      await record(`${label} verify ${check} retry`, await reach('membership-deletion-verify-submit'));
    }
    // Sending (the request never returns): no result, buttons locked.
    await visit(`delete=hang&fontScale=${scale}`, width, mode);
    await toConfirm();
    await id('membership-deletion-submit').click();
    await page.getByLabel('탈퇴 처리 중', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.lastReset ?? null), null, 'never finished while sending');
    await record(`${label} sending`);
    // Neither the request nor the status answered: 결과 다시 확인.
    await visit(`delete=unknown&fontScale=${scale}`, width, mode);
    await toConfirm();
    await id('membership-deletion-submit').click();
    await id('membership-deletion-recheck').waitFor();
    assert.equal(await id('membership-deletion-submit').count(), 0, 'no resend before the result is known');
    await record(`${label} unknown result`, await reach('membership-deletion-recheck', 'membership-deletion-cancel'));
    if (keyShots) await shot('unknown');
    // Results.
    await visit(`screen=result&status=cleanup_pending&key=1&fontScale=${scale}`, width, mode);
    await id('membership-deletion-result').waitFor();
    await record(`${label} result pending`, await reach('membership-deletion-result-recheck', 'membership-deletion-result-done'));
    if (keyShots) await shot('result-pending');
    await visit(`screen=result&status=completed&fontScale=${scale}`, width, mode);
    await id('membership-deletion-result').waitFor();
    assert.equal(await id('membership-deletion-result-recheck').count(), 0, 'no recheck once completed');
    await record(`${label} result completed`, await reach('membership-deletion-result-done'));
  }
  await browser.close(); server.close();
  console.log(`membership deletion layouts checked: ${checked}; screenshots in ${out}`);
  if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
  if (problems.length) console.log(`problems:\n${problems.join('\n')}`);
  assert.equal(errors.length, 0, 'no page errors');
  assert.equal(problems.length, 0, 'no layout problems');
  console.log('membership deletion browser checks passed');
})().catch(error => { console.error(error); process.exit(1); });
