// Real InquiryScreen (문의 내역 + 답변, operator 문의 관리), InquiryAnswerScreen
// (long original, full-length draft, confirmation, sending, failure, answered,
// a keyboard-height viewport) and OrderFailureScreen on RN-Web with a fixture
// transport: 320/375/430 dp, light/dark, font scale 1/2. Checks every glyph
// stays inside its card and the viewport, nothing is clipped by an
// overflow:hidden box, the status badge never covers the title, and the
// buttons are hit-testable. A self-test proves the detector fires.
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.INQUIRY_BROWSER_OUTPUT ?? '/tmp/trading-inquiry-answer';
const widths = process.env.INQUIRY_BROWSER_WIDTHS?.split(',').map(Number) ?? [320, 375, 430];
const scales = [1, 2], modes = ['light', 'dark'];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const mocks = path.join(__dirname, 'inquiryAnswerMocks.js');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'inquiryAnswerFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'inquiry-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|tradingAccount\/TradingAccountContext)$/ }, () => ({ path: mocks }));
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
    // A row's status badge never sits on its title.
    for (const header of document.querySelectorAll('[data-testid$="-toggle"][data-testid^="inquiry-item-"], [data-testid^="operator-inquiry-"]:not([data-testid$="-status"]):not([data-testid^="operator-inquiry-filter"])')) {
      const badge = header.querySelector('[data-testid$="-status"]'), title = header.querySelector('[dir="auto"]');
      if (!badge || !title || title === badge) { found.push(`no title/badge in ${header.dataset.testid}`); continue; }
      const b = badge.getBoundingClientRect(), titleRange = document.createRange();
      titleRange.selectNodeContents(title);
      for (const a of titleRange.getClientRects())
        if (a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5) { found.push(`badge overlaps title in ${header.dataset.testid}`); break; }
    }
    return found;
  }, mutate);
  // The control is what a tap at its centre reaches.
  const reachable = async testId => {
    const el = id(testId);
    await el.scrollIntoViewIfNeeded();
    return el.evaluate(node => { const r = node.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && node.contains(hit); });
  };
  const record = async (label, extra = []) => {
    const found = [...(await inspect()), ...extra];
    checked++;
    if (found.length) problems.push(`${label}: ${[...new Set(found)].slice(0, 6).join(' | ')}`);
  };

  // Self-test: forced nowrap + huge text must be reported.
  await visit('screen=inquiry', 320, 'light');
  await id('inquiry-item-long').waitFor();
  assert.ok((await inspect('[data-testid="inquiry-item-long-toggle"] [dir="auto"]')).some(p => p.startsWith('clipped') || p.startsWith('page')), 'detector self-test');
  await visit('screen=inquiry', 320, 'light');
  await id('inquiry-item-long').waitFor();
  await page.evaluate(() => { const badge = document.querySelector('[data-testid="inquiry-item-long-status"]'); badge.style.transform = 'translateY(-24px)'; });
  assert.ok((await inspect()).some(p => p.startsWith('badge overlaps title in inquiry-item-long')), 'overlap self-test');
  await visit('screen=inquiry&role=operator', 320, 'light');
  await id('inquiry-tab-manage').click();
  await id('operator-inquiry-long-pending').waitFor();
  await page.evaluate(() => { document.querySelector('[data-testid="operator-inquiry-long-pending-status"]').style.transform = 'translateY(-24px)'; });
  assert.ok((await inspect()).some(p => p.startsWith('badge overlaps title in operator-inquiry-long-pending')), 'operator row overlap self-test');

  for (const width of widths) for (const mode of modes) for (const scale of scales) {
    const label = `${width}/${mode}/${scale}x`;
    await visit(`screen=inquiry&fontScale=${scale}`, width, mode);
    await id('inquiry-item-long').waitFor();
    // A filled form (long title, multi-line body): the enabled submit is reachable.
    await id('inquiry-category-wallet').click();
    await id('inquiry-title').fill('가'.repeat(100));
    await id('inquiry-content').fill('첫 줄입니다.\n'.repeat(30));
    await record(`${label} inquiry list + filled form`, (await reachable('inquiry-submit')) ? [] : ['submit button covered']);
    await id('inquiry-item-long-toggle').click();
    await id('inquiry-item-long-answer').waitFor();
    await record(`${label} long answer open`);
    if (width === 320 && scale === 2 || width === 430 && scale === 1)
      await page.screenshot({ path: path.join(out, `inquiry-${label.replaceAll('/', '-')}.png`), fullPage: false });
    await id('inquiry-item-pending-toggle').click();
    await id('inquiry-item-pending-waiting').waitFor();
    assert.equal(await id('inquiry-item-pending-answer').count(), 0, 'no answer while pending');
    await record(`${label} pending open`);
    const more = await reachable('inquiry-history-more');
    await id('inquiry-history-more').click();
    await id('inquiry-item-old-22').waitFor();
    assert.equal(await id('inquiry-history-more').count(), 0, 'all pages read');
    await record(`${label} all pages`, more ? [] : ['더 보기 covered']);
    // 문의 관리 (operator): the tabs, the queue, a second page, 답변 완료.
    const shot = name => page.screenshot({ path: path.join(out, `${name}-${label.replaceAll('/', '-')}.png`) });
    const reach = async (...ids) => { const missing = []; for (const testId of ids) if (!(await reachable(testId))) missing.push(`${testId} covered`); return missing; };
    await visit(`screen=inquiry&role=operator&fontScale=${scale}`, width, mode);
    await id('inquiry-tabs').waitFor();
    await id('inquiry-item-long').waitFor();
    await record(`${label} operator 내 문의`);
    await id('inquiry-tab-manage').click();
    await id('operator-inquiry-long-pending').waitFor();
    await record(`${label} 문의 관리 queue`, await reach('operator-inquiries-refresh', 'operator-inquiry-filter-answered'));
    if (width === 320 && scale === 2) await shot('operator-queue');
    const moreMissing = await reach('operator-inquiries-more');
    await id('operator-inquiries-more').click();
    await id('operator-inquiry-p-22').waitFor();
    await record(`${label} 문의 관리 all pages`, moreMissing);
    await id('operator-inquiry-filter-answered').click();
    await id('operator-inquiry-long-answered').waitFor();
    assert.equal(await id('operator-inquiry-long-pending').count(), 0, '답변 완료 lists answered only');
    await record(`${label} 문의 관리 answered`);
    // 문의 답변: the 2000-character original, a 2000-character draft, the
    // confirmation and the sending state (the request never returns).
    const draft = '안녕하세요. 문의하신 내용을 확인했습니다.\n'.repeat(80).slice(0, 2000);
    await visit(`screen=answer&id=long-pending&role=operator&post=hang&fontScale=${scale}`, width, mode);
    await id('inquiry-answer-form').waitFor();
    await record(`${label} answer empty`);
    await id('inquiry-answer-input').fill(draft);
    await record(`${label} answer full draft`, await reach('inquiry-answer-submit'));
    await id('inquiry-answer-submit').click();
    await id('inquiry-answer-confirm').waitFor();
    await record(`${label} answer confirm`, await reach('inquiry-answer-confirm-submit', 'inquiry-answer-confirm-cancel'));
    if (width === 320 && scale === 2 || width === 430 && scale === 1) await shot('answer-confirm');
    await id('inquiry-answer-confirm-submit').click();
    await page.getByLabel('등록하기 처리 중').waitFor();
    assert.equal(await id('inquiry-answer-answer').count(), 0, 'not answered while sending');
    await record(`${label} answer sending`);
    // A keyboard-height viewport: the focused field and 답변 등록 stay reachable.
    await visit(`screen=answer&id=long-pending&role=operator&fontScale=${scale}`, width, mode, 420);
    await id('inquiry-answer-form').waitFor();
    await id('inquiry-answer-input').fill(draft.slice(0, 600));
    await id('inquiry-answer-input').focus();
    await record(`${label} answer short viewport`, await reach('inquiry-answer-input', 'inquiry-answer-submit'));
    // A lost response: the error, the text kept, never 답변 완료.
    await visit(`screen=answer&id=long-pending&role=operator&post=fail&fontScale=${scale}`, width, mode);
    await id('inquiry-answer-form').waitFor();
    await id('inquiry-answer-input').fill(draft);
    await id('inquiry-answer-submit').click();
    await id('inquiry-answer-confirm-submit').click();
    await id('inquiry-answer-error').waitFor();
    assert.equal(await id('inquiry-answer-input').inputValue(), draft, 'the text is kept');
    assert.equal(await id('inquiry-answer-answer').count(), 0, 'a failure is never shown as answered');
    await record(`${label} answer failed`, await reach('inquiry-answer-submit'));
    if (width === 320 && scale === 2) await shot('answer-failed');
    // Answered now, and an inquiry answered by another operator.
    await visit(`screen=answer&id=long-pending&role=operator&fontScale=${scale}`, width, mode);
    await id('inquiry-answer-input').fill(draft);
    await id('inquiry-answer-submit').click();
    await id('inquiry-answer-confirm-submit').click();
    await id('inquiry-answer-answer').waitFor();
    assert.equal(await id('inquiry-answer-form').count(), 0, 'no form once answered');
    await record(`${label} answer posted`);
    await visit(`screen=answer&id=long-answered&role=operator&fontScale=${scale}`, width, mode);
    await id('inquiry-answer-answer').waitFor();
    await record(`${label} answer read-only`);
    if (width === 320 && scale === 2) await shot('answer-read-only');
    for (const failure of ['failure-loc', 'failure-tpsl']) {
      await visit(`screen=${failure}&fontScale=${scale}`, width, mode);
      await id('order-failure-screen').waitFor();
      const extra = failure === 'failure-loc' && !(await reachable('order-failure-trade-history')) ? ['거래 내역 보기 covered'] : [];
      await record(`${label} ${failure}`, extra);
      if (width === 320 && scale === 2 && mode === 'dark')
        await page.screenshot({ path: path.join(out, `${failure}-${label.replaceAll('/', '-')}.png`) });
    }
  }
  await browser.close(); server.close();
  console.log(`inquiry/failure layouts checked: ${checked}; screenshots in ${out}`);
  if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
  if (problems.length) console.log(`problems:\n${problems.join('\n')}`);
  assert.equal(errors.length, 0, 'no page errors');
  assert.equal(problems.length, 0, 'no layout problems');
  console.log('inquiry answer browser checks passed');
})().catch(error => { console.error(error); process.exit(1); });
