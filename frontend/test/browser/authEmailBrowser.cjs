// Auth screens on production RN-Web components with mock delivery only.
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.AUTH_EMAIL_BROWSER_OUTPUT ?? '/tmp/trading-auth-email-ui';
const widths = [320, 375, 430], scales = [1, 2], modes = ['light', 'dark'];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const mocks = path.join(__dirname, 'authEmailMocks.js');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'authEmailFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'auth-email-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|features\/auth\/session|features\/auth\/useEnterApp|services\/api\/sessionOwnership)$/ }, () => ({ path: mocks }));
    } }], logLevel: 'warning' });
  const server = http.createServer((req, res) => {
    if (req.url === '/qa-font.ttf') { res.setHeader('Content-Type', 'font/ttf'); res.end(fs.readFileSync(process.env.AUTH_EMAIL_FONT)); return; }
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}@font-face{font-family:QAKorean;src:url(/qa-font.ttf)}body *{font-family:QAKorean,sans-serif!important}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, errors = [], problems = [], measurements = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  let page, checked = 0;
  const id = name => page.getByTestId(name);
  const visit = async (screen, width, mode, scale) => {
    if (page) await page.context().close();
    page = await browser.newPage({ viewport: { width, height: 812 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(mode => localStorage.setItem('trading-app:appearance', mode), mode);
    await page.goto(`${base}/?screen=${screen}&fontScale=${scale}`);
    await id(screen === 'Login' ? 'auth-login-screen' : screen === 'Signup' ? 'auth-signup-screen' : 'auth-password-reset').waitFor();
    await page.evaluate(() => document.fonts.load('16px QAKorean', '로그인 인증번호'));
  };
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

  const box = testId => id(testId).boundingBox();
  await visit('Login', 320, 'light', 1);
  assert.ok((await inspect('[data-testid="auth-forgot-password"] [dir="auto"]')).length > 0, 'glyph detector negative control');
  for (const width of widths) for (const mode of modes) for (const scale of scales) {
    const label = `${width}/${mode}/${scale}x`;
    await visit('Login', width, mode, scale);
    await record(`${label} login`, await reach('auth-login-submit', 'auth-signup-link', 'auth-forgot-password'));
    const login = await box('auth-login-submit'), left = await box('auth-signup-link'), right = await box('auth-forgot-password');
    assert.ok(Math.abs(left.width - right.width) < 1 && Math.abs(left.height - right.height) < 1, label);
    assert.ok(Math.abs(left.x - login.x) < 1 && Math.abs(right.x + right.width - login.x - login.width) < 1 && left.x + left.width <= right.x && Math.abs(left.y - right.y) < 1, label);
    measurements.push({ label, login, left, right });
    await id('auth-login-email-input').fill('fixture@example.com'); await id('auth-forgot-password').click();
    assert.deepEqual(await page.evaluate(() => window.lastNavigation), { name: 'PasswordReset', params: { email: 'fixture@example.com' } });
    if (width === 320 && scale === 2) await page.screenshot({ path: path.join(out, `login-${mode}-2x.png`), fullPage: true });
    for (const kind of ['Signup', 'PasswordReset']) {
      await visit(kind, width, mode, scale);
      const submit = kind === 'Signup' ? 'auth-signup-submit' : 'password-reset-submit';
      if (kind === 'Signup') {
        for (const [testId, value] of [['auth-signup-email-input', 'fixture@example.com'], ['auth-signup-nickname-input', 'fixture-user'], ['auth-signup-password-input', 'password123'], ['auth-signup-confirm-password-input', 'password123']]) await id(testId).fill(value);
      }
      await record(`${label} ${kind} initial`, await reach(submit));
      const initial = await box(submit);
      await page.evaluate(() => { window.holdSend = true; });
      await id(submit).click(); await page.waitForFunction(() => !!window.releaseSend);
      const pending = await box(submit);
      assert.ok(Math.abs(initial.height - pending.height) < 1, 'pending send height');
      await record(`${label} ${kind} pending`);
      await page.evaluate(() => { window.holdSend = false; window.releaseSend(); });
      await id('email-verification-code').waitFor();
      assert.equal(await id(submit).count(), 0);
      await id('email-verification-code').fill('123456');
      await page.evaluate(() => { window.failCode = true; });
      await id('email-verification-verify').click();
      await page.getByRole('alert').waitFor();
      // Exercise an unusually long translated error in the existing wrapping box.
      await page.getByRole('alert').evaluate(el => { el.textContent = '인증번호가 올바르지 않습니다. 입력하신 번호를 다시 확인하고 문제가 계속되면 잠시 후 인증번호를 재발송해 다시 시도해주세요. '.repeat(3); });
      await record(`${label} ${kind} code-error`, await reach('email-verification-verify', 'email-verification-resend'));
      if (width === 320 && scale === 2) await page.screenshot({ path: path.join(out, `${kind}-code-${mode}-2x.png`), fullPage: true });
      // Simulated keyboard viewport; native IME remains separate.
      await page.setViewportSize({ width, height: 420 });
      await id('email-verification-code').focus();
      await record(`${label} ${kind} keyboard`, await reach('email-verification-verify', 'email-verification-resend'));
      await page.setViewportSize({ width, height: 812 });
      await page.evaluate(() => { window.failCode = false; window.expiredCode = true; });
      await id('email-verification-resend').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="email-verification-verify"]').getAttribute('aria-disabled') === 'true');
      await record(`${label} ${kind} expired`, await reach('email-verification-resend'));
      const resendBefore = await box('email-verification-resend');
      await page.evaluate(() => { window.expiredCode = false; window.holdSend = true; window.releaseSend = null; });
      await id('email-verification-resend').click(); await page.waitForFunction(() => !!window.releaseSend);
      const resendPending = await box('email-verification-resend');
      assert.ok(Math.abs(resendBefore.height - resendPending.height) < 1, 'pending resend height');
      await record(`${label} ${kind} resend pending`);
      await page.evaluate(() => { window.holdSend = false; window.failSend = true; window.releaseSend(); });
      await page.getByRole('alert').waitFor();
      assert.equal(await id(submit).count(), 0);
      await record(`${label} ${kind} resend timeout`, await reach('email-verification-resend'));
      await page.evaluate(() => { window.failSend = false; });
      await id(kind === 'Signup' ? 'auth-signup-email-input' : 'password-reset-email').fill('fresh@example.com');
      await id(submit).click(); await id('email-verification-code').fill('123456');
      await id('email-verification-verify').click();
      await id(submit).waitFor();
      assert.equal(await id('email-verification-resend').count(), 0);
      await record(`${label} ${kind} verified`, await reach(submit));
      if (kind === 'PasswordReset') {
        await id('password-reset-password').fill('new-password'); await id('password-reset-confirm').fill('new-password');
        await page.evaluate(() => { window.holdReset = true; });
        await id(submit).click(); await page.waitForFunction(() => !!window.releaseReset);
        await record(`${label} reset pending`);
        assert.equal(await id('password-reset-complete').count(), 0);
        await page.evaluate(() => window.releaseReset()); await id('password-reset-complete').waitFor();
        await record(`${label} reset complete`);
      }
    }
  }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checked, problems, errors, measurements }, null, 2));
  await browser.close(); server.close();
  assert.equal(errors.length, 0, errors.slice(0, 5).join(' | '));
  assert.equal(problems.length, 0, problems.slice(0, 8).join(' | '));
  console.log(`auth email browser ok (${checked} layouts)`);
})().catch(error => { console.error(error); process.exit(1); });
