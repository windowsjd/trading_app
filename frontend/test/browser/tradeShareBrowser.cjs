// 수익 공유: the real TradeShareCard and TradeShareSheet in Chromium (RN Web).
// 1. Card: drawn on the capture's own 1080 × 1920 grid (DPR 1) per scenario —
//    every text inside the card and unclipped (a single line never ellipsized
//    unless the scenario is an extreme nickname), Instagram's top/bottom
//    ~250 px kept clear of key content, stacked blocks never overlapping, the
//    headline in its tone colour. Screenshots go to TRADE_SHARE_OUTPUT.
// 2. Sheet: 320–430 dp, font 1–2×, light/dark — no sideways scroll, every
//    label inside its box, the preview inside the screen.
// Run: run-browser.sh test/browser/tradeShareBrowser.cjs [TRADE_SHARE_QUICK=1]
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.TRADE_SHARE_OUTPUT ?? '/tmp/trading-trade-share';
const quick = process.env.TRADE_SHARE_QUICK === '1';
const CARD_SCENARIOS = ['design', 'rate', 'loss-big', 'loss-rate-big', 'spot-krw', 'spot-usd', 'krw-huge', 'no-prices', 'photo'];
const TONE = { design: '#14FA2A', rate: '#14FA2A', 'loss-big': '#FF3B4A', 'loss-rate-big': '#FF3B4A', 'spot-krw': '#FF3B4A', 'spot-usd': '#E8EDF7', 'krw-huge': '#14FA2A', 'no-prices': '#14FA2A', photo: '#14FA2A' };
const KEY_PARTS = ['nickname', 'time', 'title', 'direction', 'leverage', 'subtitle', 'headline', 'unit', 'price-0-label', 'price-0', 'price-1-label', 'price-1', 'brand', 'invite'];
const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();

(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'tradeShareFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'trade-share-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /services\/api\/client$/ }, () => ({ path: path.join(__dirname, 'tradeShareMocks.js') }));
    } }], logLevel: 'warning' });
  const avatar = fs.readFileSync(path.join(root, 'assets/icon/trading-class-ios-icon-1024.png'));
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(out, 'bundle.js'))); }
    if (req.url === '/avatar.png') { res.setHeader('Content-Type', 'image/png'); return res.end(avatar); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  const failures = [], errors = [], notes = [];
  let checks = 0;
  const check = (ok, message) => { checks++; if (!ok) failures.push(message); };
  try {
    // 1. The card on its own grid.
    for (const scenario of quick ? ['design', 'rate', 'spot-usd'] : CARD_SCENARIOS) {
      const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => errors.push(`${scenario}: ${e.message}`));
      await page.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.goto(`${base}/?view=card&scenario=${scenario}`);
      await page.waitForFunction(() => window.fixture?.ready === true, null, { timeout: 15000 });
      await page.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const report = await page.evaluate((parts) => {
        const card = document.querySelector('[data-testid="trade-share-card"]').getBoundingClientRect();
        const box = (id) => { const el = document.querySelector(`[data-testid="trade-share-card-${id}"]`); if (!el) return null;
          const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
          // A clamped line (numberOfLines) hides overflow: its scroll size is larger than its box.
          return { id, top: r.top, bottom: r.bottom, left: r.left, right: r.right, color: s.color, text: el.textContent,
            clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 }; };
        return { card: { width: card.width, height: card.height }, parts: parts.map(box).filter(Boolean) };
      }, KEY_PARTS);
      check(report.card.width === 1080 && report.card.height === 1920, `${scenario}: card is ${report.card.width}×${report.card.height}`);
      const byId = Object.fromEntries(report.parts.map((part) => [part.id, part]));
      for (const part of report.parts) {
        check(part.left >= 0 && part.right <= 1080 && part.top >= 0 && part.bottom <= 1920, `${scenario}: ${part.id} leaves the card`);
        // Instagram's own controls cover roughly the top and bottom 250 px of a story.
        check(part.top >= 250 && part.bottom <= 1670, `${scenario}: ${part.id} (${Math.round(part.top)}–${Math.round(part.bottom)}) outside the story safe area`);
        if (part.clipped) {
          if (scenario === 'spot-usd' && part.id === 'nickname') notes.push(`${scenario}: the extreme nickname ends in an ellipsis (2 lines at the smallest size)`);
          else check(false, `${scenario}: ${part.id} "${part.text}" is clipped`);
        }
      }
      // Stacked blocks, top to bottom, never overlap.
      const order = [['nickname', 'time'], ['title'], ['direction', 'leverage', 'subtitle'], ['headline', 'unit'], ['price-0-label', 'price-1-label'], ['price-0', 'price-1'], ['brand'], ['invite']]
        .map((group) => group.map((id) => byId[id]).filter(Boolean)).filter((group) => group.length);
      for (let i = 1; i < order.length; i++) {
        const above = Math.max(...order[i - 1].map((p) => p.bottom)), below = Math.min(...order[i].map((p) => p.top));
        check(above <= below + 1, `${scenario}: ${order[i - 1][0].id} (bottom ${Math.round(above)}) overlaps ${order[i][0].id} (top ${Math.round(below)})`);
      }
      if (byId.unit) check(byId.unit.right <= 1040 && byId.headline.right <= byId.unit.left, `${scenario}: headline and unit overrun the line`);
      check(hex(byId.headline.color) === TONE[scenario], `${scenario}: headline colour ${hex(byId.headline.color)} ≠ ${TONE[scenario]}`);
      check(byId.brand?.text === '트레이딩 클래스' && byId.invite?.text === '가상트레이딩 리그에 참여해보세요!', `${scenario}: brand lines`);
      const allText = await page.locator('[data-testid="trade-share-card"]').innerText();
      check(!/모의투자/u.test(allText), `${scenario}: extra category wording`);
      await page.screenshot({ path: path.join(out, `card-${scenario}.png`) });
      await page.close();
    }
    // 2. The sheet over phone widths, font sizes and both modes.
    const widths = quick ? [320, 390] : [320, 360, 390, 430], fonts = quick ? [1, 2] : [1, 1.5, 2], modes = quick ? ['light'] : ['light', 'dark'];
    for (const width of widths) for (const fontScale of fonts) for (const mode of modes) {
      const page = await browser.newPage({ viewport: { width, height: 780 }, deviceScaleFactor: 2 });
      page.on('pageerror', (e) => errors.push(`sheet ${width}/${fontScale}/${mode}: ${e.message}`));
      await page.route('**/*', (route) => (route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.addInitScript((appearance) => localStorage.setItem('trading-app:appearance', appearance), mode);
      await page.goto(`${base}/?view=sheet&scenario=design&fontScale=${fontScale}`);
      await page.getByTestId('trade-share-body').waitFor();
      // The sheet rises over ~280 ms; measure once it has stopped moving (a fixed wait races a busy CPU).
      await page.waitForFunction(() => {
        const top = document.querySelector('[data-testid="trade-share-body"]').getBoundingClientRect().top;
        const settled = window.__sheetTop === top;
        window.__sheetTop = top;
        return settled;
      }, null, { polling: 100, timeout: 10000 });
      const layout = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const body = document.querySelector('[data-testid="trade-share-body"]');
        const labelled = [...body.querySelectorAll('[dir="auto"]')].filter((el) => !el.closest('[data-testid="trade-share-card"]'));
        const clipped = labelled.filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).map((el) => el.textContent);
        const outside = labelled.filter((el) => { const r = el.getBoundingClientRect(); return r.left < -0.5 || r.right > viewport + 0.5; }).map((el) => el.textContent);
        const preview = document.querySelector('[data-testid="trade-share-preview"]').getBoundingClientRect();
        const sheet = body.getBoundingClientRect();
        return { sideways: document.documentElement.scrollWidth > viewport + 0.5, clipped, outside,
          preview: { left: preview.left, right: preview.right, top: preview.top, width: preview.width, height: preview.height }, viewport,
          sheetTop: sheet.top, height: document.documentElement.clientHeight };
      });
      const label = `sheet ${width}dp ×${fontScale} ${mode}`;
      check(!layout.sideways, `${label}: sideways scroll`);
      check(layout.clipped.length === 0, `${label}: clipped ${JSON.stringify(layout.clipped)}`);
      check(layout.outside.length === 0, `${label}: outside ${JSON.stringify(layout.outside)}`);
      // The sheet rises from the bottom: its body and the preview start inside the screen.
      check(layout.sheetTop >= 0 && layout.preview.top >= 0 && layout.preview.top + layout.preview.height <= layout.height, `${label}: sheet at ${Math.round(layout.sheetTop)}, preview at ${Math.round(layout.preview.top)}`);
      check(layout.preview.left >= 0 && layout.preview.right <= layout.viewport && Math.abs(layout.preview.width / layout.preview.height - 9 / 16) < 0.01,
        `${label}: preview ${JSON.stringify(layout.preview)}`);
      await page.screenshot({ path: path.join(out, `sheet-${width}-${fontScale}-${mode}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  for (const note of notes) console.log(`note: ${note}`);
  for (const error of errors) console.log(`page error: ${error}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`${checks - failures.length}/${checks} checks passed; screenshots in ${out}`);
  assert.equal(failures.length + errors.length, 0);
})().catch((error) => { console.error(error); process.exit(1); });
