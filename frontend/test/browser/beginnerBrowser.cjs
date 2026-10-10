// Same external esbuild/Playwright runtime as the existing browser checks.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.BEGINNER_BROWSER_OUTPUT ?? '/tmp/trading-beginner-browser';

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'mainTabHeadersFixture.jsx')], outfile: path.join(out, 'app.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'beginner-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'mainTabHeadersNativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook)$/ }, () => ({ path: path.join(__dirname, 'beginnerMocks.js') }));
      b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(__dirname, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/app.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'app.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/app.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser, page;
  const results = [], flows = [], errors = [], compactSteps = [];
  let shimmerMeasured = false;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(process.env.BEGINNER_CHROMIUM ? { executablePath: process.env.BEGINNER_CHROMIUM } : {}) });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const params = new URLSearchParams(location.search);
      localStorage.setItem('selectedTradingAccountId:home-user', `${params.get('account') ?? 'beginner'}-account`);
      localStorage.setItem('trading-app:appearance', params.get('theme') ?? 'light');
    });
    const id = value => page.getByTestId(value).filter({ visible: true }).first();
    const tab = label => page.getByRole('tablist').getByRole('tab', { name: label, exact: true });
    const heading = label => page.getByRole('heading', { name: label, exact: true }).filter({ visible: true }).first();
    async function waitForQuestCompletion(quest) {
      await page.waitForFunction(quest => document.querySelector(`[data-testid="quest-card-${quest}-status"]`)?.textContent === '완료', quest, { timeout: 8000 });
    }
    async function open(query = '') { await page.goto(`${base}/?${query}`); await id('home-account-title').waitFor(); }
    async function settled(testId) {
      await page.waitForFunction(testId => {
        const element = [...document.querySelectorAll(`[data-testid="${testId}"]`)].find(node => node.checkVisibility());
        if (!element) return false;
        for (let parent = element; parent; parent = parent.parentElement) {
          if (Number(getComputedStyle(parent).opacity) < 0.999) return false;
        }
        return true;
      }, testId);
    }
    async function geometry() {
      const bounds = await page.evaluate(() => ['quests', 'guide'].map(section => {
        const element = document.querySelector(`[data-testid="beginner-segment-${section}"]`);
        const r = element.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height, inside: text.left >= r.left - 1 && text.right <= r.right + 1 && text.top >= r.top - 1 && text.bottom <= r.bottom + 1 };
      }));
      assert.equal(bounds.every(b => b.height >= 44 && b.inside), true);
      assert.equal(bounds[0].right <= bounds[1].left, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const labelsFit = await page.getByRole('tablist').getByRole('tab').evaluateAll(tabs => tabs.every(tab => {
        const hit = tab.getBoundingClientRect();
        const label = [...tab.querySelectorAll('*')].find(node => node.childNodes.length === 1 && node.firstChild.nodeType === Node.TEXT_NODE);
        if (!label) return false;
        const box = label.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(label);
        const glyph = range.getBoundingClientRect();
        return hit.width >= 44 && hit.height >= 44 && glyph.left >= box.left - 1 && glyph.right <= box.right + 1 && glyph.bottom <= hit.bottom + 1;
      }));
      assert.equal(labelsFit, true, 'all five tab labels fit their separate touch targets');
    }
    // Every visible text run stays inside the viewport and its own box; every
    // button keeps a 44px target with its label inside (no truncation/clipping).
    async function contentFits(testId) {
      const issues = await page.evaluate(testId => {
        const root = [...document.querySelectorAll(`[data-testid="${testId}"]`)].find(element => element.checkVisibility());
        if (!root) return [`missing ${testId}`];
        const found = [];
        for (const element of [root, ...root.querySelectorAll('*')]) {
          if (!element.checkVisibility()) continue;
          if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
          const range = document.createRange(); range.selectNodeContents(element);
          const glyph = range.getBoundingClientRect();
          if (glyph.left < -1 || glyph.right > innerWidth + 1) found.push(`offscreen:${element.textContent.slice(0, 24)}`);
          if (getComputedStyle(element).display !== 'inline'
            && (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)) found.push(`clipped:${element.textContent.slice(0, 24)}`);
        }
        for (const button of root.querySelectorAll('[role="button"]')) {
          if (!button.checkVisibility()) continue;
          const hit = button.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(button);
          const glyph = range.getBoundingClientRect();
          if (hit.height < 44 || glyph.left < hit.left - 1 || glyph.right > hit.right + 1 || glyph.bottom > hit.bottom + 1) found.push(`button:${button.textContent.slice(0, 24)}`);
        }
        return found;
      }, testId);
      assert.deepEqual(issues, [], testId);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const text = async testId => (await id(testId).textContent()) ?? '';
    const box = async locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
    const union = boxes => ({ left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)), right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)) });
    const intersects = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

    /**
     * One spotlight step: the ring wraps exactly the real control (6px), the
     * card is fully readable on screen, does not cover that control, and the
     * control itself still receives the user's press (checked by the caller).
     */
    async function expectSpotlight(targets, { body, stepLabel, context }) {
      await settled('quest-guide-card');
      await page.getByTestId('quest-guide-ring').waitFor();
      if (body) await page.waitForFunction(body => document.querySelector('[data-testid="quest-guide-body"]')?.textContent === body, body);
      // A compact card (tight space, large text) drops the quest label and counter.
      const compact = await page.getByTestId('quest-guide-head').count() === 0;
      if (stepLabel && !compact) assert.equal(await text('quest-guide-step'), stepLabel);
      if (compact) compactSteps.push(`${context}`);
      const ring = await box(page.getByTestId('quest-guide-ring'));
      const target = union(await Promise.all(targets.map(locator => box(locator))));
      const viewport = page.viewportSize();
      const visibleTarget = { left: Math.max(target.left, 0), top: Math.max(target.top, 0), right: Math.min(target.right, viewport.width), bottom: Math.min(target.bottom, viewport.height) };
      for (const side of ['left', 'top']) assert.ok(ring[side] <= visibleTarget[side] + 1 && ring[side] >= visibleTarget[side] - 9, `${context} ring ${side} ${JSON.stringify({ ring, target })}`);
      for (const side of ['right', 'bottom']) assert.ok(ring[side] >= visibleTarget[side] - 1 && ring[side] <= visibleTarget[side] + 9, `${context} ring ${side} ${JSON.stringify({ ring, target })}`);
      const dim = await page.getByTestId('quest-guide-spotlight').evaluate(el => {
        const svg = el.querySelector('svg'), path = svg?.querySelector('path'), r = svg?.getBoundingClientRect();
        let opacity = 1;
        for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        return { width: r?.width ?? 0, height: r?.height ?? 0, fill: path?.getAttribute('fill'), opacity,
          rule: path?.getAttribute('fill-rule'), events: getComputedStyle(el).pointerEvents };
      });
      assert.ok(dim.width >= viewport.width - 1 && dim.height >= viewport.height - 1, `${context} dim covers the screen ${JSON.stringify(dim)}`);
      assert.equal(dim.opacity, 1, `${context} dim fully shown`);
      assert.equal(dim.rule, 'evenodd');
      assert.match(dim.fill, /^rgba\(/);
      assert.equal(dim.events, 'none', 'the dim never takes touches');
      const card = await box(page.getByTestId('quest-guide-card'));
      assert.equal(intersects(card, target), false, `${context} card must not cover the control ${JSON.stringify({ card, target })}`);
      assert.ok(card.left >= 0 && card.right <= viewport.width && card.top >= 0 && card.bottom <= viewport.height, `${context} card on screen`);
      await contentFits('quest-guide-card');
      return { ring, card, target };
    }

    async function checkEntryHighlight(button, { ring, target }) {
      const margins = [target.left - ring.left, ring.right - target.right, target.top - ring.top, ring.bottom - target.bottom];
      assert.ok(Math.abs(margins[0] - margins[1]) <= 1 && Math.abs(margins[2] - margins[3]) <= 1, `symmetric padding ${JSON.stringify(margins)}`);
      const group = await box(id(`${button}-guide-target`)), item = await box(id(`${button}-item`));
      assert.ok(group.right - group.left <= item.right - item.left + 1, 'measured content never exceeds its responsive column');
      const surface = id(`${button}-surface`);
      assert.equal(await surface.getByTestId('quest-target-glow').count(), 1);
      assert.equal(await page.getByTestId('quest-target-glow').count(), 1, 'only the current button glows');
      assert.equal(await surface.getByTestId('quest-target-highlight').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
      const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
      assert.equal(await surface.getByTestId('quest-target-shimmer').count(), reduced ? 0 : 1);
      await contentFits(`${button}-guide-target`);
      if (!reduced && button === 'wallet-exchange' && !shimmerMeasured) {
        const samples = await page.evaluate(() => new Promise(resolve => {
          const samples = [], started = performance.now(); let sampledAt = -100;
          function tick(now) {
            if (now - sampledAt >= 40) {
              const el = document.querySelector('[data-testid="quest-target-shimmer"]');
              const surface = el.closest('[data-testid="wallet-exchange-surface"]');
              const rect = surface.getBoundingClientRect();
              samples.push({ ms: now - started, x: new DOMMatrix(getComputedStyle(el).transform).m41, width: rect.width, height: rect.height });
              sampledAt = now;
            }
            if (now - started < 3000) requestAnimationFrame(tick); else resolve(samples);
          }
          requestAnimationFrame(tick);
        }));
        assert.ok(Math.max(...samples.map(s => s.x)) - Math.min(...samples.map(s => s.x)) > 100, 'shimmer crosses the whole surface');
        assert.ok(samples.some((s, i) => i && s.x < samples[i - 1].x - 50), 'the 2.5s cycle restarts');
        assert.ok(samples.some((s, i) => i && s.x > samples[i - 1].x + 2), 'sweep moves from left to right');
        assert.ok(samples.filter((s, i) => i && Math.abs(s.x - samples[i - 1].x) < 0.1).length > samples.length / 2, 'most of the cycle has no moving shine');
        assert.ok(samples.every(s => Math.abs(s.width - 52) < 1 && Math.abs(s.height - 52) < 1), 'the icon stays fixed size');
        fs.writeFileSync(path.join(out, 'shimmer-motion.json'), JSON.stringify(samples, null, 2));
        shimmerMeasured = true;
        flows.push({ context: 'shimmer-motion', direction: 'left-to-right', cycleRestart: true, fixedIcon: true });
      }

    }

    // The completion badge shows its check above the brand gradient.
    async function expectBadgeCheck() {
      const badge = await page.evaluate(() => {
        const check = [...document.querySelectorAll('[data-testid="quest-guide-celebration"] path')].find(p => p.getAttribute('d') === 'M5 12.5l4.5 4.5L19 7.5');
        if (!check) return { state: 'missing' };
        const svg = check.closest('svg'), style = getComputedStyle(svg), r = svg.getBoundingClientRect();
        // The gradient is an absolutely positioned earlier sibling; a static SVG
        // would be painted underneath it on Web.
        const gradient = [...svg.parentElement.children].find(node => node !== svg && getComputedStyle(node).position === 'absolute');
        return { state: 'found', position: style.position, after: !!gradient && !!(gradient.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING),
          stroke: svg.getAttribute('stroke'), visible: svg.checkVisibility() && r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
      });
      assert.deepEqual(badge, { state: 'found', position: 'relative', after: true, stroke: '#FFFFFF', visible: true });
    }

    async function recordFrames() {
      await page.evaluate(() => {
        window.questFrames = [];
        window.questFramesActive = true;
        const visible = testId => [...document.querySelectorAll(`[data-testid="${testId}"]`)].some(node => node.checkVisibility());
        const loop = () => {
          const nav = window.fixture.navigationRef;
          window.questFrames.push({
            route: nav.isReady() ? nav.getCurrentRoute()?.name : null,
            celebration: visible('quest-guide-celebration'),
            fx: visible('wallet-fx-screen'), transfer: visible('wallet-transfer-screen'), list: visible('beginner-quest-list'),
            sheet: document.body.textContent.includes('환전이 완료되었습니다'),
          });
          if (window.questFramesActive) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
    }
    async function stopFrames() {
      return page.evaluate(() => { window.questFramesActive = false; return window.questFrames; });
    }
    function assertSmoothReturn(frames, practice) {
      assert.equal(frames.some(frame => frame.sheet), false, 'no FX success sheet next to the celebration');
      const routes = frames.map(frame => frame.route).filter((route, index, all) => route && route !== all[index - 1]);
      assert.deepEqual(routes, [practice === 'fx' ? 'WalletFx' : 'WalletTransfer', 'Guide'], `one direct return, no Wallet flash: ${routes}`);
      const firstList = frames.findIndex(frame => frame.route === 'Guide');
      assert.ok(firstList > 0);
      assert.equal(frames[firstList - 1].celebration, true, 'the celebration covers the tab switch');
      // The practice screen is visible in one run only; once hidden it never
      // returns, and while it fades out underneath the celebration covers it.
      const shown = frames.map(frame => frame[practice]);
      const lastShown = shown.lastIndexOf(true);
      assert.equal(shown.slice(0, lastShown + 1).every(Boolean), true, 'the practice screen never reappears');
      assert.equal(frames.slice(firstList, lastShown + 1).every(frame => frame.celebration), true, 'covered during the switch');
      assert.ok(frames.filter(frame => frame.celebration).length >= 20, 'the completion is visible long enough to notice');
    }

    // A: quest list, header and tab icon at small widths, both themes, large fonts.
    const headerOf = label => heading(label).evaluate(el => {
      const row = el.parentElement, icon = row.querySelector('svg'), s = getComputedStyle(el);
      const r = el.getBoundingClientRect(), i = icon.getBoundingClientRect();
      return { weight: s.fontWeight, size: parseFloat(s.fontSize), family: s.fontFamily, color: s.color,
        iconWidth: i.width, gap: Math.round(r.left - i.right), centerDelta: Math.abs((i.top + i.bottom) / 2 - (r.top + r.bottom) / 2),
        paths: [...icon.querySelectorAll('path')].map(p => p.getAttribute('d')), stroke: icon.getAttribute('stroke') };
    });
    for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 2]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 844 });
      const level = fontScale === 2 ? '1' : '0';
      await open(`fontScale=${fontScale}&theme=${theme}&quest=${level}`);
      assert.equal(await id('home-account-title').textContent(), '초보모드');
      await tab('지갑').click(); await heading('지갑').waitFor();
      const walletHeader = await headerOf('지갑');
      await tab('퀘스트').click(); await id('quest-card-exchange').waitFor();
      await settled('beginner-quest-list');
      const questHeader = await headerOf('퀘스트');
      for (const key of ['weight', 'size', 'family', 'color', 'iconWidth', 'gap', 'stroke']) {
        assert.equal(questHeader[key], walletHeader[key], `quest header ${key} matches the other tabs`);
      }
      assert.ok(questHeader.centerDelta < 1);
      assert.ok(questHeader.paths.some(d => d.includes('M5 21V3')), 'quest flag in the header');
      const tabIcon = await tab('퀘스트').evaluate(el => [...el.querySelectorAll('path')].map(p => p.getAttribute('d')).join('|'));
      assert.ok(tabIcon.includes('M4 3h2v18H4z'), 'filled quest flag on the selected tab');
      assert.doesNotMatch(tabIcon, /M3 3h6c1\.3/, 'not the guide book');
      assert.equal(await page.getByRole('tablist').getByRole('tab').count(), 5);
      const list = await text('beginner-quest-list');
      assert.doesNotMatch(list, /실제 거래 기능을 직접 사용해 보며 단계별로 배워요/);
      assert.doesNotMatch(list, /\d+%|경험치|레벨|해금|잠금|보상|배우는 내용:|완료 ·|다시 둘러보기/);
      if (level === '1') { assert.equal(await id('quest-card-exchange-start').getAttribute('aria-label'), '다시하기'); assert.equal(await id('quest-card-exchange-start').getByTestId('quest-replay-icon').count(), 1); }
      assert.equal(await text('quest-summary-progress'), `퀘스트 ${level}/2 완료`);
      assert.equal(await text('quest-card-exchange-status'), level === '1' ? '완료' : '미시작');
      assert.equal(await text('quest-card-transfer-status'), level === '1' ? '미시작' : '대기');
      assert.equal(await id('quest-card-transfer-start').getAttribute('aria-disabled'), level === '1' ? null : 'true');
      await geometry(); await contentFits('beginner-quest-list');
      if (width === 320 || width === 430) await page.screenshot({ path: path.join(out, `quest-list-${width}-${fontScale}-${theme}.png`), fullPage: true });
      await id('beginner-segment-guide').click(); await id('guide-market-basics-card').waitFor();
      await geometry();
      await id('beginner-segment-quests').click(); await id('beginner-quest-list').waitFor();
      results.push({ width, fontScale, theme, quest: level, header: 'matches 지갑', list: 'pass' });
    }

    // B: both practices end to end on the real Wallet screens.
    async function practiceExchange(context) {
      await tab('퀘스트').click(); await id('quest-card-exchange-start').waitFor();
      await id('quest-card-exchange-start').click();
      await id('wallet-screen').waitFor();
      const entry = await expectSpotlight([id('wallet-exchange-surface'), id('wallet-exchange-label')], { body: '환전하기에서는 KRW와 USD 환전을 할 수 있어요.', stepLabel: '1/6', context: `${context} entry` });
      await checkEntryHighlight('wallet-exchange', entry);
      if (context.endsWith('390')) assert.ok(page.viewportSize().width - entry.card.right <= 13, 'entry card sits top-right');
      await page.screenshot({ path: path.join(out, `fx-1-entry-${context}.png`) });
      await id('wallet-exchange').click(); // the real button, through the overlay
      await id('wallet-fx-screen').waitFor();
      assert.equal(await page.getByTestId('quest-target-highlight').count(), 0, 'entry animation is disposed on navigation');
      await expectSpotlight([id('wallet-fx-direction-row')], { stepLabel: '2/6', context: `${context} direction` });
      await page.screenshot({ path: path.join(out, `fx-2-direction-${context}.png`) });
      await id('quest-guide-next').click();
      await expectSpotlight([id('wallet-fx-amount-input')], { stepLabel: '3/6', context: `${context} amount` });
      assert.equal(await id('quest-guide-next').getAttribute('aria-disabled'), 'true', 'no amount, no next');
      await id('wallet-fx-amount-input').fill('135000');
      await page.waitForFunction(() => document.querySelector('[data-testid="quest-guide-next"]')?.getAttribute('aria-disabled') !== 'true');
      await page.screenshot({ path: path.join(out, `fx-3-amount-${context}.png`) });
      await id('quest-guide-next').click();
      await expectSpotlight([id('fx-quote-title'), id('fx-preview-rate')], { stepLabel: '4/6', context: `${context} quote` });
      await page.screenshot({ path: path.join(out, `fx-4-quote-${context}.png`) });
      await id('quest-guide-next').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="fx-preview-fee"]') && (document.querySelector('[data-testid="quest-guide-step"]')?.textContent ?? '5/6') === '5/6');
      await expectSpotlight([id('fx-preview-fee'), id('fx-preview-net')], { stepLabel: '5/6', context: `${context} fee` });
      await page.screenshot({ path: path.join(out, `fx-5-fee-${context}.png`) });
      await id('quest-guide-next').click();
      await expectSpotlight([id('wallet-fx-execute-submit')], { stepLabel: '6/6', context: `${context} submit` });
      await page.screenshot({ path: path.join(out, `fx-6-submit-${context}.png`) });
      await recordFrames();
      await id('wallet-fx-execute-submit').click();
      await id('quest-guide-celebration').waitFor();
      assert.equal(await text('quest-guide-celebration-title'), '환전하기 퀘스트 완료!');
      await page.waitForTimeout(450);
      await expectBadgeCheck();
      await page.screenshot({ path: path.join(out, `fx-7-celebration-${context}.png`) });
      await waitForQuestCompletion('exchange');
      await page.waitForFunction(() => !document.querySelector('[data-testid="quest-guide-celebration"]'));
      await page.waitForTimeout(400);
      assertSmoothReturn(await stopFrames(), 'fx');
      assert.equal(await text('quest-card-exchange-status'), '완료');
      assert.equal(await text('quest-card-transfer-status'), '미시작');
      assert.equal(await id('quest-card-transfer-start').getAttribute('aria-disabled'), null, 'QUEST 02 can start now');
      await page.screenshot({ path: path.join(out, `fx-8-returned-${context}.png`) });
    }
    async function practiceTransfer(context) {
      await id('quest-card-transfer-start').click();
      await id('wallet-screen').waitFor();
      const entry = await expectSpotlight([id('wallet-transfer-surface'), id('wallet-transfer-label')], { body: '이체하기에서는 같은 통화를 내 지갑 사이에서 옮길 수 있어요.', stepLabel: '1/6', context: `${context} transfer entry` });
      await checkEntryHighlight('wallet-transfer', entry);
      await page.screenshot({ path: path.join(out, `tr-1-entry-${context}.png`) });
      await id('wallet-transfer').click();
      await id('wallet-transfer-screen').waitFor();
      await expectSpotlight([id('wallet-transfer-source-card')], { stepLabel: '2/6', context: `${context} source` });
      await page.screenshot({ path: path.join(out, `tr-2-source-${context}.png`) });
      await id('quest-guide-next').click();
      await expectSpotlight([id('wallet-transfer-destination-card')], { stepLabel: '3/6', context: `${context} destination` });
      await id('quest-guide-next').click();
      await expectSpotlight([id('wallet-transfer-amount-field')], { stepLabel: '4/6', context: `${context} amount` });
      await id('wallet-transfer-amount').fill('10');
      await page.waitForFunction(() => document.querySelector('[data-testid="quest-guide-next"]')?.getAttribute('aria-disabled') !== 'true');
      await page.screenshot({ path: path.join(out, `tr-4-amount-${context}.png`) });
      await id('quest-guide-next').click();
      await expectSpotlight([id('wallet-transfer-amount-field'), id('wallet-transfer-available')], { stepLabel: '5/6', context: `${context} review` });
      await page.screenshot({ path: path.join(out, `tr-5-review-${context}.png`) });
      await id('quest-guide-next').click();
      await expectSpotlight([id('wallet-transfer-submit')], { stepLabel: '6/6', context: `${context} submit` });
      await recordFrames();
      await id('wallet-transfer-submit').click();
      await id('quest-guide-celebration').waitFor();
      assert.equal(await text('quest-guide-celebration-title'), '이체하기 퀘스트 완료!');
      await page.waitForTimeout(450);
      await expectBadgeCheck();
      await page.screenshot({ path: path.join(out, `tr-7-celebration-${context}.png`) });
      await waitForQuestCompletion('transfer');
      await page.waitForFunction(() => !document.querySelector('[data-testid="quest-guide-celebration"]'));
      await page.waitForTimeout(400);
      assertSmoothReturn(await stopFrames(), 'transfer');
      assert.equal(await text('quest-summary-progress'), '퀘스트 2/2 완료');
      await page.screenshot({ path: path.join(out, `tr-8-returned-${context}.png`) });
    }
    for (const [width, height, fontScale, theme, motion] of [
      [390, 844, 1, 'light', 'no-preference'], [320, 640, 2, 'dark', 'no-preference'], [360, 740, 1, 'dark', 'reduce'],
    ]) {
      const context = `${theme}-${fontScale}x-${motion}-${width}`;
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: motion });
      await open(`practice=1&fxState=available&fontScale=${fontScale}&theme=${theme}`);
      await practiceExchange(context);
      await practiceTransfer(context);
      const posts = await page.evaluate(() => window.beginnerFixture.posts);
      assert.deepEqual(posts.map(p => p.replace(/^\/trading-accounts\/[^/]+/, '')), ['/fx/quote', '/fx/execute', '/wallet-transfers'], 'exactly one user command per practice');
      flows.push({ context, exchange: 'pass', transfer: 'pass', posts: posts.length });
    }

    // Completed quests perform new real commands, retain timestamps, and return without confetti.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open('practice=1&fxState=available&quest=2&fontScale=2&theme=dark');
    await tab('퀘스트').click();
    const original = await page.evaluate(() => ({ fxAt: window.beginnerFixture.ledger.fxAt, transferAt: window.beginnerFixture.ledger.transferAt }));
    for (const quest of ['exchange', 'transfer']) {
      assert.equal(await id(`quest-card-${quest}-start`).getAttribute('aria-label'), '다시하기');
      await id(`quest-card-${quest}-start`).click();
      await id(`wallet-${quest}`).click();
      await page.getByTestId('quest-guide-card').waitFor();
      if (quest === 'exchange') {
        await id('quest-guide-next').click(); await id('wallet-fx-amount-input').fill('13500');
      } else {
        await id('quest-guide-next').click(); await id('quest-guide-next').click(); await id('wallet-transfer-amount').fill('10');
      }
      for (let step = 0; step < (quest === 'exchange' ? 3 : 2); step++) {
        await page.waitForFunction(() => document.querySelector('[data-testid="quest-guide-next"]')?.getAttribute('aria-disabled') !== 'true');
        await id('quest-guide-next').click();
      }
      await id(quest === 'exchange' ? 'wallet-fx-execute-submit' : 'wallet-transfer-submit').click();
      await id('quest-guide-celebration').waitFor();
      assert.equal(await text('quest-guide-celebration-title'), '실습을 완료했어요.');
      assert.equal(await page.getByTestId('quest-confetti-piece').count(), 0);
      await settled('quest-guide-celebration');
      await page.screenshot({ path: path.join(out, `replay-${quest}-success.png`) });
      await page.waitForFunction(() => !document.querySelector('[data-testid="quest-guide-celebration"]'));
      await id('beginner-quest-list').waitFor(); await contentFits('beginner-quest-list');
      assert.equal(await text('quest-summary-progress'), '퀘스트 2/2 완료');
    }
    assert.deepEqual(await page.evaluate(() => ({ fxAt: window.beginnerFixture.ledger.fxAt, transferAt: window.beginnerFixture.ledger.transferAt })), original);
    assert.equal((await page.evaluate(() => window.beginnerFixture.posts)).length, 3);
    flows.push({ context: 'replays', noConfetti: true, timestampsPreserved: true, realCommands: 2 });

    // The shared finance forms also validate cash reservations in every account mode.
    await page.setViewportSize({ width: 320, height: 640 });
    for (const account of ['general', 'season', 'beginner']) {
      await open(`account=${account}&holdings=1&practice=1&quest=2&fxState=available&fontScale=2&theme=dark`);
      await tab('지갑').click(); await id('wallet-exchange').click(); await id('wallet-fx-screen').waitFor();
      const available = async currency => page.evaluate(({ account, currency }) => {
        const data = window.fixture.client.getQueryCache().getAll().find(q => q.queryKey.includes('wallets') && q.queryKey.includes(`${account}-account`)).state.data;
        const wallet = data.wallets.find(w => w.walletScope === 'securities' && w.currencyCode === currency);
        return Number(wallet.balanceAmount) - Number(wallet.reservedAmount);
      }, { account, currency });
      for (const currency of ['KRW', 'USD']) {
        await id(currency === 'KRW' ? 'wallet-fx-direction-krw-usd' : 'wallet-fx-direction-usd-krw').click();
        const cash = await available(currency);
        await id('wallet-fx-amount-input').fill((cash + 1).toFixed(8));
        await page.getByText('잔액이 부족합니다.', { exact: true }).filter({ visible: true }).waitFor();
        assert.equal(await id('wallet-fx-execute-submit').getAttribute('aria-disabled'), 'true');
        await contentFits('wallet-fx-screen');
        await id('wallet-fx-execute-submit').scrollIntoViewIfNeeded();
        await page.getByText('잔액이 부족합니다.', { exact: true }).filter({ visible: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(out, `insufficient-fx-${account}-${currency}.png`), fullPage: true });
        await id('wallet-fx-amount-input').fill(cash.toFixed(8));
        await page.waitForFunction(() => document.querySelector('[data-testid="wallet-fx-execute-submit"]')?.getAttribute('aria-disabled') !== 'true');
        assert.equal(await page.getByText('잔액이 부족합니다.', { exact: true }).count(), 0);
        await id('wallet-fx-amount-input').fill('1e3');
        assert.equal(await page.getByText('잔액이 부족합니다.', { exact: true }).count(), 0);
        assert.equal(await id('wallet-fx-execute-submit').getAttribute('aria-disabled'), 'true');
      }
      await page.getByLabel(/back|뒤로/i).filter({ visible: true }).first().click();
      await id('wallet-transfer').click(); await id('wallet-transfer-screen').waitFor();
      const cash = await available('USD');
      await id('wallet-transfer-amount').fill((cash + 1).toFixed(8));
      await page.getByText('잔액이 부족합니다.', { exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await id('wallet-transfer-submit').getAttribute('aria-disabled'), 'true');
      await contentFits('wallet-transfer-screen');
      await id('wallet-transfer-submit').scrollIntoViewIfNeeded();
      await page.getByText('잔액이 부족합니다.', { exact: true }).filter({ visible: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `insufficient-transfer-${account}.png`), fullPage: true });
      await id('wallet-transfer-amount').fill(cash.toFixed(8));
      assert.equal(await id('wallet-transfer-submit').getAttribute('aria-disabled'), null);
      assert.equal(await page.getByTestId('quest-target-highlight').count(), 0);
      assert.equal((await page.evaluate(() => window.beginnerFixture.posts)).length, 0, 'validation never sends a financial command');
    }
    flows.push({ context: 'balance-validation', accounts: 3, directions: 2, reservations: true, exactBalance: true, commands: 0 });

    // C: Reduced Motion keeps the guidance and the completion, without motion.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open('practice=1&fxState=available');
    await tab('퀘스트').click(); await id('quest-card-exchange-start').click();
    await page.getByTestId('quest-guide-ring').waitFor();
    await id('wallet-exchange').click();
    await page.getByTestId('quest-guide-ring').waitFor();
    assert.equal(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    await id('quest-guide-next').click();
    await id('wallet-fx-amount-input').fill('27000');
    for (const step of ['4/6', '5/6', '6/6']) {
      await page.waitForFunction(() => document.querySelector('[data-testid="quest-guide-next"]')?.getAttribute('aria-disabled') !== 'true');
      await id('quest-guide-next').click();
      await page.waitForFunction(step => document.querySelector('[data-testid="quest-guide-step"]')?.textContent === step, step);
    }
    await id('wallet-fx-execute-submit').click();
    await id('quest-guide-celebration').waitFor();
    assert.equal(await page.getByTestId('quest-confetti-piece').count(), 0, 'no confetti under Reduced Motion');
    await page.screenshot({ path: path.join(out, 'reduced-motion-celebration.png') });
    await waitForQuestCompletion('exchange');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    flows.push({ context: 'reduced-motion', confetti: 0, returned: true });

    // D: an unconfirmed completion is never shown as done; retry confirms it.
    await open('practice=1&fxState=available');
    await tab('퀘스트').click(); await id('quest-card-exchange-start').click();
    await id('wallet-exchange').click();
    await id('quest-guide-next').click();
    await id('wallet-fx-amount-input').fill('13500');
    for (const step of ['4/6', '5/6', '6/6']) {
      await page.waitForFunction(() => document.querySelector('[data-testid="quest-guide-next"]')?.getAttribute('aria-disabled') !== 'true');
      await id('quest-guide-next').click();
      await page.waitForFunction(step => document.querySelector('[data-testid="quest-guide-step"]')?.textContent === step, step);
    }
    await page.evaluate(() => { window.beginnerFixture.questFailures = 2; });
    await id('wallet-fx-execute-submit').click();
    await id('quest-guide-retry').waitFor({ timeout: 8000 });
    assert.equal(await page.getByTestId('quest-guide-celebration').count(), 0, 'no celebration without proof');
    await contentFits('quest-guide-card');
    await page.screenshot({ path: path.join(out, 'unconfirmed.png') });
    await id('quest-guide-retry').click();
    await id('quest-guide-celebration').waitFor();
    await waitForQuestCompletion('exchange');
    assert.deepEqual((await page.evaluate(() => window.beginnerFixture.posts)).map(p => p.replace(/^\/trading-accounts\/[^/]+/, '')), ['/fx/quote', '/fx/execute'], 'retry re-reads progress, never re-executes');
    flows.push({ context: 'unconfirmed-then-retry', pass: true });

    // E: exit, Back and account switching never carry a guide elsewhere.
    await open('practice=1&fxState=available');
    await tab('퀘스트').click(); await id('quest-card-exchange-start').click();
    await page.getByTestId('quest-guide-ring').waitFor();
    await id('quest-guide-exit').click();
    assert.equal(await page.getByTestId('quest-guide-card').count(), 0);
    await tab('퀘스트').click();
    assert.equal(await text('quest-card-exchange-status'), '미시작');
    await id('quest-card-exchange-start').click();
    await id('wallet-exchange').click();
    await page.getByTestId('quest-guide-ring').waitFor();
    await page.getByLabel(/back|뒤로/i).filter({ visible: true }).first().click();
    await id('wallet-screen').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="quest-guide-step"]')?.textContent === '1/6');
    await tab('퀘스트').click();
    assert.equal(await text('quest-card-exchange-status'), '진행 중');
    assert.equal(await page.getByTestId('quest-guide-card').count(), 0, 'the overlay pauses on other tabs');
    await tab('홈').click();
    await id('trading-account-switcher-trigger').click();
    await id('trading-account-switcher-option-general-account').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="home-account-title"]')?.textContent === '일반모드');
    await tab('지갑').click(); await id('wallet-screen').waitFor();
    assert.equal(await page.getByTestId('quest-guide-card').count(), 0, 'no guide on the general account');
    await tab('홈').click();
    await id('trading-account-switcher-trigger').click();
    await id('trading-account-switcher-option-beginner-account').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="home-account-title"]')?.textContent === '초보모드');
    await tab('퀘스트').click();
    assert.equal(await text('quest-card-exchange-status'), '미시작', 'the old session did not survive the switch');
    assert.equal(await page.evaluate(() => window.beginnerFixture.posts.length), 0);
    flows.push({ context: 'exit-back-switch', pass: true });

    // F: the FX screen for every mode: no account switcher, three equal rows.
    for (const [account, width, fontScale, theme] of [['general', 320, 2, 'light'], ['season', 360, 1, 'dark'], ['beginner', 320, 1, 'dark']]) {
      await page.setViewportSize({ width, height: 844 });
      await open(`account=${account}&fxState=available&fontScale=${fontScale}&theme=${theme}${account === 'beginner' ? '&practice=1' : '&holdings=1'}`);
      await tab('지갑').click(); await id('wallet-exchange').click();
      await id('fx-wallet-summary').waitFor();
      await settled('wallet-fx-screen');
      const fxScreen = page.getByTestId('wallet-fx-screen').filter({ visible: true }).first();
      assert.equal(await fxScreen.getByTestId('trading-account-switcher-trigger').count(), 0, `${account}: no switcher on FX`);
      assert.equal(await fxScreen.getByText('투자 계정', { exact: true }).count(), 0, `${account}: no switcher label on FX`);
      const summary = await page.getByTestId('fx-wallet-summary').filter({ visible: true }).first().evaluate(el => [...el.children].map(row => [...row.querySelectorAll('div')]
        .filter(node => node.childNodes.length === 1 && node.firstChild.nodeType === Node.TEXT_NODE)
        .map(node => ({ text: node.textContent, size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight }))));
      assert.deepEqual(summary.map(row => row[0].text), ['KRW Wallet', 'USD Wallet', '환율']);
      assert.equal(new Set(summary.flat().map(cell => `${cell.size}/${cell.weight}`)).size, 1, 'one size and weight');
      assert.equal(summary.flat()[0].size, `${18 * fontScale}px`);
      const fxText = await text('wallet-fx-screen');
      assert.doesNotMatch(fxText, /지갑 요약|USD 환산|수집 시각|대체 환율/);
      await contentFits('fx-wallet-summary');
      await page.screenshot({ path: path.join(out, `fx-summary-${account}-${width}-${fontScale}-${theme}.png`) });
      results.push({ fxSummary: account, width, fontScale, theme, switcher: 'absent', rows: 3 });
    }
    await open('account=general&fontScale=2&theme=light&holdings=1');
    await tab('지갑').click(); await id('wallet-exchange').click();
    await id('fx-rate-unavailable').waitFor();
    assert.equal(await text('fx-summary-rate'), '-', 'no invented rate');
    await contentFits('fx-rate-unavailable');
    await page.screenshot({ path: path.join(out, 'fx-summary-rate-unavailable.png'), fullPage: true });

    // G: delayed answers and switching keep every account's data separate.
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    for (const [account, title, third] of [['general-account', '일반모드', '가이드'], ['season-account', 'Season 1', '랭킹'], ['beginner-account', '초보모드', '퀘스트']]) {
      await id('trading-account-switcher-trigger').click();
      await id(`trading-account-switcher-option-${account}`).click();
      await page.waitForFunction(title => document.querySelector('[data-testid="home-account-title"]')?.textContent === title, title);
      await tab(third).waitFor();
      await tab('MY').waitFor();
      assert.equal(await page.evaluate(() => window.beginnerFixture.posts.length), 0);
    }
    await open('account=general&holdings=1');
    await page.waitForFunction(() => document.querySelector('[data-testid="home-total-asset"]')?.textContent === '12,530,200원');
    await page.evaluate(() => {
      window.accountLeaks = [];
      new MutationObserver(() => {
        const title = document.querySelector('[data-testid="home-account-title"]')?.textContent;
        const expected = title === '초보모드' ? ['10,000,000원', 'beginner-account'] : title === '일반모드' ? ['12,530,200원', 'general-account'] : null;
        if (!expected) return;
        const amount = document.querySelector('[data-testid="home-total-asset"]')?.textContent;
        if (amount && amount !== expected[0]) window.accountLeaks.push({ title, amount });
        for (const row of document.querySelectorAll('[data-testid^="home-position-item-"]')) {
          if (row.checkVisibility() && !row.dataset.testid.includes(expected[1])) window.accountLeaks.push({ title, position: row.dataset.testid });
        }
      }).observe(document.getElementById('root'), { subtree: true, childList: true, characterData: true });
      window.beginnerFixture.delay = 'beginner-account';
    });
    async function switchTo(account) {
      await id('trading-account-switcher-trigger').click();
      await id(`trading-account-switcher-option-${account}-account`).click();
      await page.waitForFunction(title => document.querySelector('[data-testid="home-account-title"]')?.textContent === title, account === 'beginner' ? '초보모드' : '일반모드');
    }
    await switchTo('beginner');
    await page.waitForFunction(() => window.beginnerFixture.pending.length > 0);
    assert.equal(await page.getByTestId('home-total-asset').filter({ visible: true }).count(), 0, 'previous balance is absent while beginner loads');
    await page.evaluate(() => { window.beginnerFixture.delay = null; window.beginnerFixture.release(); });
    await page.waitForFunction(() => document.querySelector('[data-testid="home-total-asset"]')?.textContent === '10,000,000원');
    await id('home-position-item-beginner-account-asset-0').waitFor();
    const priorResponses = await page.evaluate(() => {
      window.beginnerFixture.delay = 'beginner-account';
      void window.fixture.client.invalidateQueries({ predicate: query => query.queryKey.includes('beginner-account') && query.queryKey.includes('portfolio') });
      return window.beginnerFixture.responses.filter(path => path === '/trading-accounts/beginner-account/portfolio').length;
    });
    await page.waitForFunction(() => window.beginnerFixture.pending.length > 0);
    await switchTo('general');
    await page.evaluate(() => { window.beginnerFixture.delay = null; window.beginnerFixture.release(); });
    await page.waitForFunction(prior => window.beginnerFixture.responses.filter(path => path === '/trading-accounts/beginner-account/portfolio').length > prior, priorResponses);
    await page.waitForFunction(() => document.querySelector('[data-testid="home-total-asset"]')?.textContent === '12,530,200원');
    assert.deepEqual(await page.evaluate(() => window.accountLeaks), []);
    await tab('지갑').click(); await id('wallet-cash-KRW').waitFor();
    assert.match(await id('wallet-cash-KRW').textContent(), /9,900,000/);
    await tab('홈').click(); await switchTo('beginner');
    await tab('지갑').click(); await id('wallet-cash-KRW').waitFor();
    assert.match(await id('wallet-cash-KRW').textContent(), /8,800,000/);
    assert.equal(await page.evaluate(() => window.beginnerFixture.posts.length), 0);
    // A quest answer that arrives after switching away never paints elsewhere.
    await open('quest=2');
    await page.evaluate(() => { window.beginnerFixture.questDelay = true; });
    await tab('퀘스트').click(); await id('quest-card-loading').waitFor();
    await page.waitForFunction(() => window.beginnerFixture.pending.length > 0);
    await tab('홈').click(); await switchTo('general');
    await page.evaluate(() => { window.beginnerFixture.questDelay = false; window.beginnerFixture.release(); });
    await page.waitForFunction(() => window.beginnerFixture.responses.includes('/trading-accounts/beginner-account/quests'));
    await tab('가이드').waitFor();
    assert.equal(await page.locator('[data-testid^="quest-"]').filter({ visible: true }).count(), 0);
    await switchTo('beginner');
    await tab('퀘스트').click();
    await id('quest-summary-progress').waitFor();
    assert.equal(await text('quest-summary-progress'), '퀘스트 2/2 완료');
    // Unknown progress is shown as unknown at the narrowest, largest layout.
    await page.setViewportSize({ width: 320, height: 844 });
    await open('quest=error&fontScale=2&theme=dark');
    await tab('퀘스트').click(); await id('quest-card-error').waitFor();
    await settled('beginner-quest-list');
    assert.equal(await text('quest-card-exchange-status'), '확인 불가');
    assert.equal(await id('quest-card-exchange-start').getAttribute('aria-disabled'), 'true');
    await contentFits('beginner-quest-list');
    await page.screenshot({ path: path.join(out, 'quest-error-2-dark.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await open('enabled=0');
    assert.equal(await id('home-account-title').textContent(), '초보모드');
    await id('trading-account-switcher-trigger').click();
    assert.equal(await page.getByTestId('trading-account-switcher-option-beginner-account').count(), 1);
    assert.equal(await page.getByTestId('beginner-account-entry').count(), 0);
    await open('newBeginner=1&account=general&enabled=0');
    await id('trading-account-switcher-trigger').click();
    assert.equal(await page.evaluate(() => window.beginnerFixture.posts.length), 0);
    await id('beginner-account-start').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="home-account-title"]')?.textContent === '초보모드');
    assert.deepEqual(await page.evaluate(() => window.beginnerFixture.posts), ['/trading-accounts/beginner']);
    await tab('퀘스트').waitFor();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, flows, compactSteps, accountSwitching: 'pass', delayedFinancialIsolation: 'pass', explicitCreation: 'pass', errors }, null, 2));
    console.log(`beginner browser checks passed: ${results.length} layouts, ${flows.length} guided flows (spotlight geometry, real presses, celebration, smooth return, Reduced Motion, unconfirmed retry, exit/back/switch), FX summary for three modes, account isolation and explicit creation`);
  } finally {
    await page?.screenshot({ path: path.join(out, 'last-screen.png') }).catch(() => {});
    await browser?.close(); server.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
