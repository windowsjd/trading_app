// 회원가입 동의·약관 상세(2026-11-13) on production RN-Web screens with mock transport.
// NODE_PATH=<browser-tools>/node_modules BROWSER_EXECUTABLE_PATH=… SIGNUP_CONSENT_FONT=<Korean .ttf>
// node test/browser/signupConsentBrowser.cjs   (SIGNUP_CONSENT_OUTPUT for the bundle/screenshots)
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.SIGNUP_CONSENT_OUTPUT ?? '/tmp/trading-signup-consent-ui';
const widths = [320, 375, 430], scales = [1, 2], modes = ['light', 'dark'];
const BOXES = ['auth-signup-age-checkbox', 'auth-signup-terms-checkbox', 'auth-signup-privacy-checkbox'];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const mocks = path.join(__dirname, 'authEmailMocks.js');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'signupConsentFixture.jsx')], outfile: path.join(out, 'bundle.js'), bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'signup-consent-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|features\/auth\/session|features\/auth\/useEnterApp|services\/api\/sessionOwnership)$/ }, () => ({ path: mocks }));
    } }], logLevel: 'warning' });
  const font = process.env.SIGNUP_CONSENT_FONT;
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
  const visit = async (screen, width, mode, scale) => {
    if (page) await page.context().close();
    page = await browser.newPage({ viewport: { width, height: 740 }, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(`${screen} ${width}: ${e.message}`));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(mode => localStorage.setItem('trading-app:appearance', mode), mode);
    await page.goto(`${base}/?screen=${screen}&fontScale=${scale}`);
    await id(screen === 'Signup' ? 'auth-signup-screen' : `legal-document-${screen}`).waitFor();
    await page.evaluate(() => document.fonts.load('16px QAKorean', '회원가입 이용약관'));
  };
  // Every glyph inside the viewport width, its bordered box and any clipping ancestor; no sideways page scroll.
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
    const el = id(testId).first();
    await el.scrollIntoViewIfNeeded();
    return el.evaluate(node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && node.contains(hit); });
  };
  const record = async (label, extra = []) => {
    const found = [...(await inspect()), ...extra];
    checked++;
    if (found.length) problems.push(`${label}: ${[...new Set(found)].slice(0, 6).join(' | ')}`);
  };
  const checked3 = () => page.evaluate(ids => ids.map(testId => document.querySelector(`[data-testid="${testId}"]`)?.getAttribute('aria-checked')), BOXES);

  // The glyph detector must catch a forced overflow (negative control).
  await visit('Signup', 320, 'light', 1);
  assert.ok((await inspect('[data-testid="auth-signup-consents"] *')).length > 0, 'glyph detector negative control');

  for (const width of widths) for (const scale of scales) for (const mode of modes) {
    const label = `${width}px ${scale}x ${mode}`;
    await visit('Signup', width, mode, scale);
    const extra = [];
    if (JSON.stringify(await checked3()) !== JSON.stringify(['false', 'false', 'false'])) extra.push(`boxes not all unchecked: ${await checked3()}`);
    for (const testId of [...BOXES, 'auth-signup-terms-detail', 'auth-signup-privacy-detail']) if (!(await reachable(testId))) extra.push(`${testId} covered`);
    await record(`Signup ${label}`, extra);
    for (const [doc, kind] of [['terms', 'auth-signup-terms-detail'], ['privacy', 'auth-signup-privacy-detail']]) {
      await visit(doc, width, mode, scale);
      const found = [];
      const texts = await page.evaluate(() => document.body.innerText);
      const summary = texts.indexOf('핵심 내용 요약'), full = texts.indexOf('전문');
      if (!(summary > 0 && full > summary)) found.push('summary is not before the full text');
      for (const heading of doc === 'terms' ? ['제1조 목적', '제7조 이용제한', '제14조 약관의 변경'] : ['1. 개인정보의 처리 목적', '4. 개인정보의 처리위탁 및 국외 처리', '10. 개인정보처리방침의 변경'])
        if (!texts.includes(heading)) found.push(`missing ${heading}`);
      const rows = await id('legal-document-table-row').count();
      if (rows !== (doc === 'terms' ? 0 : 28)) found.push(`${rows} table rows`);
      if (!(await reachable('legal-document-back'))) found.push('back button covered');
      await record(`${doc} ${label}`, found);
      void kind;
    }
  }

  // Behaviour (one layout): each box toggles only itself; 자세히 보기 navigates and checks nothing;
  // the missing consents are named; the back button returns.
  await visit('Signup', 375, 'light', 1);
  await id('auth-signup-terms-checkbox').click();
  assert.deepEqual(await checked3(), ['false', 'true', 'false']);
  await id('auth-signup-terms-detail').click();
  await id('auth-signup-privacy-detail').click();
  assert.deepEqual(await page.evaluate(() => window.navigations), [
    { name: 'LegalDocument', params: { document: 'terms' } }, { name: 'LegalDocument', params: { document: 'privacy' } }]);
  assert.deepEqual(await checked3(), ['false', 'true', 'false'], 'opening a document checks nothing');
  await id('auth-signup-email-input').fill('new@example.com');
  await id('auth-signup-nickname-input').fill('새회원');
  await id('auth-signup-password-input').fill('password-123');
  await id('auth-signup-confirm-password-input').fill('password-123');
  await id('auth-signup-submit').click();
  await page.getByText('만 16세 이상 확인, 개인정보처리방침 동의에 체크해주세요.').waitFor();
  assert.equal(await page.evaluate(() => window.authCalls.length), 0, 'nothing is sent without every consent');
  await id('auth-signup-age-checkbox').click();
  await id('auth-signup-privacy-checkbox').click();
  await id('auth-signup-submit').click();
  await page.waitForFunction(() => window.authCalls.includes('/auth/email/request'));
  await page.screenshot({ path: path.join(out, 'signup-375.png'), fullPage: true });
  await visit('privacy', 320, 'dark', 2);
  await page.screenshot({ path: path.join(out, 'privacy-320-2x-dark.png') });
  await id('legal-document-back').click();
  assert.deepEqual(await page.evaluate(() => window.navigations), [{ name: 'goBack' }]);

  await browser.close(); server.close();
  console.log(`${checked} layouts checked`);
  if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
  if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; }
  else if (!errors.length) console.log('signup consent browser ok');
  else process.exitCode = 1;
})().catch(error => { console.error(error); process.exit(1); });
