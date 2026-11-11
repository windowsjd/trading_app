// 퀘스트 강조 영역 점검 (2026-11-10). The full-app RN-Web fixture (production
// navigators, screens, quest guide and overlay; beginnerMocks transport) plays
// all 10 quests, step by step, at several screen sizes, safe-area insets and
// font scales. In the page every stable spotlight step is sampled: the ring must
// contain what can be seen of every shown target (its box and the content
// drawn in it, through its scroll views and sheets), stay on screen, and the
// step card must stay on screen without covering the shown targets — except
// the documented last resort, listed, where a target is taller than the screen
// and not even the smallest card fits beside it. Every step shown must hold
// still long enough to be sampled (the script waits for it). A step's extra
// targets that gave way to the card (small screens, large text), and a current
// step that drew nothing for a second or more, are listed. Build-time only, this script exposes the overlay's current view and
// the bridge's target lookup on globalThis (an esbuild onLoad patch).
//
// NODE_PATH=<playwright+esbuild> BROWSER_EXECUTABLE_PATH=<chromium> node test/browser/questSpotlightBrowser.cjs
//   QUEST_SPOTLIGHT_CONFIGS=base,nav3,compact,mid (default all) · QUEST_SPOTLIGHT_OUTPUT=<dir>
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const front = path.resolve(__dirname, '../..');
const browserDir = __dirname;
const out = process.env.QUEST_SPOTLIGHT_OUTPUT ?? '/tmp/trading-quest-spotlight';
const configs = (process.env.QUEST_SPOTLIGHT_CONFIGS ?? 'base,nav3,compact,mid').split(',');
const CONFIG = {
  base: { width: 390, height: 844, query: '' },
  nav3: { width: 390, height: 844, query: 'topInset=24&bottomInset=48' },
  compact: { width: 320, height: 740, query: 'fontScale=2&theme=dark', reduced: true },
  mid: { width: 360, height: 780, query: 'fontScale=1.3&bottomInset=24&topInset=24' },
};

const patch = { name: 'audit-hooks', setup(b) {
  b.onLoad({ filter: /features\/quest\/questGuideBridge\.ts$/ }, async (args) => ({
    contents: fs.readFileSync(args.path, 'utf8') + '\nglobalThis.__questBridge = { getQuestGuideTarget };\n', loader: 'ts' }));
  b.onLoad({ filter: /features\/quest\/QuestGuideOverlay\.tsx$/ }, async (args) => {
    const src = fs.readFileSync(args.path, 'utf8');
    const marker = '  const rootRef = useRef<View>(null);';
    if (!src.includes(marker)) throw new Error('overlay marker missing');
    let contents = src.replace(marker, '  globalThis.__questView = view;\n' + marker);
    const shown = "  const targetList = shownTargets.join(',');";
    if (contents.includes(shown)) contents = contents.replace(shown, shown + '\n  globalThis.__questShown = targetList;');
    return { contents, loader: 'tsx' };
  });
} };

async function build() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(browserDir, 'mainTabHeadersFixture.jsx')], outfile: path.join(out, 'app.js'),
    bundle: true, minify: false, platform: 'browser', format: 'iife', nodePaths: [path.join(front, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [patch, { name: 'beginner-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(browserDir, 'mainTabHeadersNativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|useMarketTickers|useAssetTicker|useAssetCandle|useAssetOrderBook|useFuturesOrderBook)$/ }, () => ({ path: path.join(browserDir, 'beginnerMocks.js') }));
      b.onResolve({ filter: /screens\/auth\/SplashScreen$/ }, () => ({ path: path.join(browserDir, 'navigationBootstrap.jsx') }));
    } }], logLevel: 'warning',
  });
}

// In-page sampler: records the last stable geometry per spotlight anchor.
function sampler() {
  window.__audit = {};
  let last = null, stable = 0;
  const R = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const union = (rs) => rs.length ? { left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)),
    right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)) } : null;
  const opacity = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
  const contains = (outer, inner, slack = 0.5) => outer.left <= inner.left + slack && outer.top <= inner.top + slack
    && outer.right >= inner.right - slack && outer.bottom >= inner.bottom - slack;
  const intersects = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  // Visible content of a target: its own box and every drawn descendant, clipped
  // by overflow-hidden ancestors inside the target (a scroll view's hidden rows
  // are not drawn), skipping the outside glow and invisible measurers.
  function content(node) {
    const boxes = [R(node.getBoundingClientRect())];
    for (const el of node.querySelectorAll('*')) {
      if (el.closest('[data-testid="quest-target-highlight"]')) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (el.closest('[aria-hidden="true"]') && el.tagName.toLowerCase() !== 'svg' && !el.closest('svg')) continue;
      let r = R(el.getBoundingClientRect());
      if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue;
      for (let p = el.parentElement; p && p !== node.parentElement; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const c = R(p.getBoundingClientRect());
          r = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
        }
      }
      if (r.right - r.left > 0.5 && r.bottom - r.top > 0.5) boxes.push(r);
    }
    return union(boxes);
  }
  const loop = () => {
    try {
      const view = globalThis.__questView;
      if (view?.kind === 'spotlight') { window.__seen ??= {}; window.__seen[view.anchor] = (window.__seen[view.anchor] ?? 0) + 1; }
      const ring = document.querySelector('[data-testid="quest-guide-ring"]');
      const card = document.querySelector('[data-testid="quest-guide-card"]');
      // The current step drawing nothing (its targets scrolled out of sight, a transition).
      if (view?.kind === 'spotlight' && !card) { window.__blank ??= {}; window.__blank[view.anchor] = (window.__blank[view.anchor] ?? 0) + 1; }
      if (view?.kind === 'spotlight' && card && opacity(card) > 0.99 && !ring) {
        window.__noRing ??= {};
        window.__noRing[view.anchor] = (window.__noRing[view.anchor] ?? 0) + 1;
      }
      if (view?.kind === 'spotlight' && ring && card && opacity(card) > 0.99 && opacity(ring) > 0.99) {
        const shownIds = typeof globalThis.__questShown === 'string' && globalThis.__questShown ? globalThis.__questShown.split(',') : view.targets;
        const nodes = shownIds.map((id) => globalThis.__questBridge.getQuestGuideTarget(id));
        if (nodes.every((n) => n && n.getBoundingClientRect)) {
          // What can be seen of each target: its box clipped by every clipping ancestor (scroll views, sheets).
          const seen = (n) => { let r = R(n.getBoundingClientRect());
            for (let p = n.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p);
              if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const c = R(p.getBoundingClientRect());
                r = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) }; } }
            return r; };
          let targets = union(nodes.map(seen));
          // The market list is spotlit below its own header by design (HEADER_TARGET).
          if (shownIds.length === 1 && shownIds[0] === 'market-assets') {
            const header = globalThis.__questBridge.getQuestGuideTarget('market-list-header')?.getBoundingClientRect();
            if (header && header.bottom > targets.top) targets = { ...targets, top: header.bottom };
          }
          const drawnRaw = union(nodes.map(content));
          // Drawn content, seen through the same clipping as the targets.
          const drawn = { left: Math.max(drawnRaw.left, targets.left - 2), top: Math.max(drawnRaw.top, targets.top),
            right: Math.min(drawnRaw.right, targets.right + 2), bottom: Math.min(drawnRaw.bottom, targets.bottom) };
          const ringBox = R(ring.getBoundingClientRect());
          const cardBox = R(card.getBoundingClientRect());
          const text = card.querySelector('[data-testid="quest-guide-text"]');
          const sample = {
            anchor: view.anchor, targetIds: view.targets, shownIds, dropped: view.targets.filter((id) => !shownIds.includes(id)),
            pageScrollX: scrollX, docWidth: document.documentElement.scrollWidth, step: card.querySelector('[data-testid="quest-guide-step"]')?.textContent ?? null,
            title: view.card.title, body: view.card.body.slice(0, 40), next: view.card.next,
            targets, drawn, ring: ringBox, card: cardBox,
            ringCoversTargets: contains(ringBox, targets), ringCoversDrawn: contains(ringBox, drawn),
            ringOnScreen: ringBox.left >= -0.5 && ringBox.top >= -0.5 && ringBox.right <= innerWidth + 0.5 && ringBox.bottom <= innerHeight + 0.5,
            cardOnScreen: cardBox.left >= -0.5 && cardBox.top >= -0.5 && cardBox.right <= innerWidth + 0.5 && cardBox.bottom <= innerHeight + 0.5,
            cardCoversTarget: intersects(cardBox, targets),
            cardTextScrolls: !!text && text.scrollHeight > text.clientHeight + 1,
            compactCard: !card.querySelector('[data-testid="quest-guide-head"]'),
          };
          // The documented last resort (placeGuideCard): beside a target taller
          // than the screen not even the smallest card fits, so that card sits at
          // the roomier edge over the target. Judged here from the screen itself
          // (window minus the fixture's safe-area insets), not from the model.
          const params = new URLSearchParams(location.search);
          const roomAbove = ringBox.top - Number(params.get('topInset') ?? 0);
          const roomBelow = innerHeight - Number(params.get('bottomInset') ?? 0) - ringBox.bottom;
          sample.lastResort = sample.cardCoversTarget && sample.compactCard
            && cardBox.bottom - cardBox.top > Math.max(roomAbove, roomBelow)
            && (cardBox.top + cardBox.bottom < ringBox.top + ringBox.bottom) === (roomAbove >= roomBelow);
          sample.room = { above: roomAbove, below: roomBelow };
          const round = (r) => [r.left, r.top, r.right, r.bottom].map(Math.round);
          const key = JSON.stringify([sample.anchor, round(sample.targets), round(sample.ring), round(sample.card)]);
          stable = key === last ? stable + 1 : 0;
          last = key;
          if (stable === 20) window.__audit[view.anchor] = sample;
        }
      } else { last = null; stable = 0; }
    } catch (error) { window.__auditError = String(error?.stack ?? error); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

async function runConfig(name, browser, base) {
  const cfg = CONFIG[name];
  const page = await browser.newPage({ viewport: { width: cfg.width, height: cfg.height } });
  if (cfg.reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const params = new URLSearchParams(location.search);
    localStorage.setItem('selectedTradingAccountId:home-user', `${params.get('account') ?? 'beginner'}-account`);
    localStorage.setItem('trading-app:appearance', params.get('theme') ?? 'light');
  });
  await page.addInitScript(sampler);
  const id = (v) => page.getByTestId(v).filter({ visible: true }).first();
  const tab = (label) => page.locator('a[role="tab"]').filter({ has: page.getByText(label, { exact: true }) });
  const shot = (label) => page.screenshot({ path: path.join(out, `${name}-${label}.png`) });
  // Wait, then (while a step card exists) until it is fully shown and has held still for its sampling.
  const settle = async (ms = 700) => {
    await page.waitForTimeout(ms);
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="quest-guide-card"]');
      if (!card) return true;
      let o = 1; for (let n = card; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return o > 0.99;
    }, undefined, { timeout: 4000 }).catch(() => undefined);
    // The current spotlight step has held still long enough to be sampled.
    await page.waitForFunction(() => {
      const view = globalThis.__questView;
      return view?.kind !== 'spotlight' || !!window.__audit?.[view.anchor];
    }, undefined, { timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(450);
  };
  const next = async () => {
    await id('quest-guide-next').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="quest-guide-next"]')].some(el => el.checkVisibility() && el.getAttribute('aria-disabled') !== 'true'));
    await settle(450);
    await id('quest-guide-next').click();
  };
  const open = async (query) => { await page.goto(`${base}/?${query}${cfg.query ? '&' + cfg.query : ''}`); await id('home-account-title').waitFor(); };
  // The beginner's 퀘스트 is a hidden tab opened from Home's header (2026-11-07): navigate as that button does.
  const start = async (key) => {
    // Web-fixture artifact: focus on Home's 퀘스트 badge (8 px past the edge, as at HEAD) can scroll an
    // overflow-hidden container sideways; a device never scrolls it. Undo that before each quest.
    await page.evaluate(() => document.querySelectorAll('*').forEach((el) => { if (el.scrollLeft) el.scrollLeft = 0; }));
    await page.evaluate(() => window.fixture.navigationRef.navigate('MainTabs', { screen: 'QuestTab', params: { screen: 'Guide', pop: true } }));
    await id(`quest-card-${key}-start`).click();
  };
  const finish = async (key) => {
    await id('quest-guide-celebration').waitFor();
    await page.waitForFunction((key) => [...document.querySelectorAll(`[data-testid="quest-card-${key}-status"]`)].some(el => el.checkVisibility() && el.textContent === '완료'), key);
    await page.waitForFunction(() => !document.querySelector('[data-testid="quest-guide-celebration"]'));
  };
  const done = [];
  // QUEST 01 · 02 on the real Wallet sheets.
  await open('quest=0&practice=1&fxState=available');
  await start('exchange'); await id('wallet-screen').waitFor(); await settle(); await shot('q01-entry');
  await id('wallet-exchange').click(); await id('wallet-fx-screen').waitFor(); await settle(); await shot('q01-direction');
  await next(); await settle(); await id('wallet-fx-krw-amount-input').fill('135000'); await settle(); await shot('q01-amount');
  await next(); await settle(); await shot('q01-quote'); await next(); await settle(); await shot('q01-fee'); await next(); await settle(); await shot('q01-submit');
  await id('wallet-fx-execute-submit').click(); await finish('exchange'); done.push('exchange');
  await start('transfer'); await id('wallet-screen').waitFor(); await settle(); await shot('q02-entry');
  await id('wallet-transfer').click(); await id('wallet-transfer-screen').waitFor(); await settle(); await shot('q02-source');
  await next(); await settle(); await shot('q02-destination'); await next(); await settle();
  await id('wallet-transfer-amount').fill('10'); await settle(); await shot('q02-amount'); await next(); await settle(); await shot('q02-review');
  await next(); await settle(); await shot('q02-submit'); await id('wallet-transfer-submit').click(); await finish('transfer'); done.push('transfer');
  const wallet = await page.evaluate(() => window.__audit);
  const walletSeen = await page.evaluate(() => window.__seen ?? {});
  const walletBlank = await page.evaluate(() => window.__blank ?? {});

  // QUEST 03–10 on the real order/futures screens (practice transport).
  await page.evaluate(() => { window.__audit = {}; });
  await open('practice=1&fullQuests=1&quest=2&fxState=available');
  const pick = async (method, key) => {
    await id('order-type-select').click(); await id(`order-method-${method}`).waitFor(); await settle(900); await shot(`${key}-method-${method}`);
    await id(`order-method-${method}`).click(); await page.waitForFunction(() => !document.querySelector('[data-testid="order-method-sheet"]'));
  };
  const buy = async (key, asset) => {
    await start(key); await page.getByTestId('quest-guide-ring').waitFor(); await settle(); await shot(`${key}-market`);
    await id(`market-item-${asset}`).click(); await settle(); await shot(`${key}-price`); await next(); await settle(); await shot(`${key}-buy`);
    await id('asset-detail-open-buy-order').click(); await settle(); await shot(`${key}-type`);
    if (key === 'limitBuy') await pick('limit', key);
    await next(); await settle(); await shot(`${key}-input-empty`);
    if (key === 'limitBuy') await id('order-limit-price-input').fill('90');
    await id('order-quantity-input').fill(asset === 'BTC' ? '100' : '1'); await settle(); await shot(`${key}-input`);
    await next(); await settle(); await shot(`${key}-preview`); await next(); await settle(); await shot(`${key}-submit`);
    await id('order-execute-submit').click();
    if (key === 'limitBuy') { await settle(); await shot(`${key}-review`); await id('quest-limit-cancel').click(); }
    else { await settle(); await shot(`${key}-holdings`); }
    await next(); await finish(key); done.push(key);
  };
  await buy('marketBuy', 'BTC');
  await start('protection');
  const holdingTpSl = page.locator('[data-testid^="holding-"][data-testid$="-tp-sl"]').filter({ visible: true }).first();
  await holdingTpSl.waitFor(); await settle(); await shot('protection-entry');
  await holdingTpSl.scrollIntoViewIfNeeded(); await holdingTpSl.click(); await id('tp-sl-spot-holding').waitFor(); await settle(900); await shot('protection-editor');
  await id('tp-sl-take-profit-toggle').click(); await id('tp-sl-take-profit-trigger-price').fill('120'); await id('tp-sl-take-profit-ratio-50').click(); await settle(); await shot('protection-editor-filled');
  await next(); await settle(900); await shot('protection-submit'); await id('tp-sl-submit').click(); await finish('protection'); done.push('protection');
  await start('marketSell'); await settle(); await shot('marketSell-sell');
  await id('asset-detail-open-sell-order').click(); await settle(); await shot('marketSell-holdings'); await next(); await settle(); await shot('marketSell-type');
  await next(); await settle(); await shot('marketSell-input-empty');
  // 매도 금액 (USD) since 2026-11-10.
  await id('order-quantity-input').fill('50'); await settle(); await shot('marketSell-input');
  await next(); await settle(); await shot('marketSell-preview'); await next(); await settle(); await shot('marketSell-submit');
  await id('order-execute-submit').click(); await finish('marketSell'); done.push('marketSell');
  await buy('limitBuy', 'BTC');
  await buy('usStock', 'US'); await buy('krStock', 'KR');
  for (const [key, direction] of [['futuresShort', '숏(Short)'], ['futuresLong', '롱(Long)']]) {
    await start(key); await id('futures-screen').waitFor(); await settle(); await shot(`${key}-funding`);
    await next(); await settle(); await shot(`${key}-instrument`); await next(); await settle(); await shot(`${key}-direction`);
    await page.getByRole('tab', { name: direction, exact: true }).click(); await next(); await settle(); await shot(`${key}-margin`);
    await id('futures-leverage-select').click(); await id('futures-leverage-option-2').waitFor(); await settle(900); await shot(`${key}-leverage`);
    await id('futures-leverage-option-2').click(); await page.waitForFunction(() => !document.querySelector('[data-testid="futures-leverage-sheet"]'));
    await next(); await settle(); await shot(`${key}-submit-empty`);
    await id('futures-amount').fill('102'); await settle(); await shot(`${key}-submit`); await id('futures-submit').click();
    await settle(900); await shot(`${key}-position`);
    // The position card can be taller than the screen: press as a keyboard user would (the guide card may sit over it).
    const close = page.getByRole('button', { name: '포지션 종료', exact: true }).filter({ visible: true }).first();
    await close.focus(); await page.keyboard.press('Enter');
    await id('futures-close-submit').waitFor(); await settle(450); await id('futures-close-submit').click(); await finish(key); done.push(key);
  }
  const trading = await page.evaluate(() => window.__audit);
  const auditError = await page.evaluate(() => window.__auditError ?? null);
  const noRing = await page.evaluate(() => window.__noRing ?? {});
  const seen = { ...walletSeen, ...(await page.evaluate(() => window.__seen ?? {})) };
  const blank = { ...walletBlank, ...(await page.evaluate(() => window.__blank ?? {})) };
  await page.close();
  return { name, done, errors, auditError, noRing, seen, blank, samples: { ...wallet, ...trading } };
}

(async () => {
  await build();
  const server = http.createServer((req, res) => {
    const script = req.url.startsWith('/app.js');
    res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
    res.end(script ? fs.readFileSync(path.join(out, 'app.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/app.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  const report = [];
  try {
    for (const name of configs) {
      try { report.push(await runConfig(name, browser, base)); }
      catch (error) { report.push({ name, failed: String(error?.stack ?? error).slice(0, 2000) }); }
    }
  } finally { await browser.close(); server.close(); }
  fs.writeFileSync(path.join(out, 'quest-spotlight.json'), JSON.stringify(report, null, 2));
  let failed = false;
  for (const r of report) {
    if (r.failed) { console.log(`CONFIG ${r.name} FAILED: ${r.failed}`); failed = true; continue; }
    const samples = Object.values(r.samples);
    const bad = samples.filter((s) => !s.ringCoversTargets || !s.ringCoversDrawn || !s.ringOnScreen || !s.cardOnScreen || (s.cardCoversTarget && !s.lastResort));
    console.log(`CONFIG ${r.name}: quests ${r.done.length}/10 [${r.done.join(',')}], steps sampled ${samples.length}, problems ${bad.length}, pageErrors ${r.errors.length}${r.auditError ? ', auditError ' + r.auditError.slice(0, 200) : ''}`);
    for (const s of samples.filter((x) => x.dropped.length)) console.log('  ↘ gave way', s.anchor, '→ dropped', s.dropped.join(','));
    for (const s of samples.filter((x) => x.cardCoversTarget && x.lastResort)) console.log('  ↘ last resort', s.anchor, `smallest card over a target taller than the screen (room above ${Math.round(s.room.above)}, below ${Math.round(s.room.below)}, card ${Math.round(s.card.bottom - s.card.top)})`);
    const unsampled = Object.keys(r.noRing ?? {}).filter((a) => !r.samples[a]);
    if (unsampled.length) console.log('  ○ card without ring (never sampled):', unsampled.join(' | '));
    // Shown for about half a second or more (30 frames) yet never sampled: never verified.
    const neverSampled = Object.entries(r.seen ?? {}).filter(([a, frames]) => frames >= 30 && !r.samples[a]).map(([a]) => a);
    if (neverSampled.length) console.log('  ✗ shown but never sampled:', neverSampled.join(' | '));
    // Informational: a current step that drew nothing for a second or more (e.g. typing scrolled its control away).
    for (const [a, frames] of Object.entries(r.blank ?? {}).filter(([, frames]) => frames >= 60)) console.log('  ◌ blank while current', a, `${frames} frames`);
    if (bad.length || neverSampled.length || r.done.length !== 10 || r.errors.length || r.auditError) failed = true;
    for (const s of bad) console.log('  ✗', s.anchor, JSON.stringify({ scrollX: s.pageScrollX, docWidth: s.docWidth, title: s.title, targetIds: s.targetIds, coversTargets: s.ringCoversTargets, coversDrawn: s.ringCoversDrawn, ringOnScreen: s.ringOnScreen, cardOnScreen: s.cardOnScreen, cardCoversTarget: s.cardCoversTarget, ring: s.ring, targets: s.targets, drawn: s.drawn }));
  }
  if (failed) process.exitCode = 1;
  else console.log('quest spotlight browser checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
