// Actual RankingScreen/SVG/theme/queries/formatter/touch ink; fixture transport.
const assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'), out = process.env.RANKING_TIER_OUTPUT ?? '/tmp/trading-ranking-tiers';
const baseline = process.env.RANKING_TIER_BASELINE_SOURCE, quick = process.env.RANKING_TIER_QUICK === '1';
const tiers = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master', 'unknown'];
const widths = process.env.RANKING_TIER_WIDTHS?.split(',').map(Number) ?? (quick ? [390] : [320, 360, 390, 430]);
const scales = process.env.RANKING_TIER_FONTS?.split(',').map(Number) ?? (quick ? [1] : [1, 1.5, 2]);
const modes = process.env.RANKING_TIER_MODES?.split(',') ?? ['light', 'dark'];
// Row-2 is mine, and 내 순위 shows its figures: positive, negative, zero and unavailable
// rates rotate over the tiers, nickname lengths and palettes. Short totals are realistic.
const MY_RETURNS = ['4.5', '-12.34', '0', 'none'], MY_TOTAL = '10450000';
const rateText = value => value === 'none' ? '-' : `${Number(value) > 0 ? '+' : ''}${value}%`;
const LONG_TOTAL = '1,234,567,890,123,456원';
// The screen's plain card (semantic surface and border) per mode.
const CARD = { light: ['rgb(255, 255, 255)', 'rgb(229, 232, 235)'], dark: ['rgb(28, 29, 33)', 'rgb(59, 61, 67)'] };
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, 'rankingTierFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'ranking-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks)$/ }, () => ({ path: path.join(__dirname, 'rankingTierMocks.js') }));
      if (baseline) b.onResolve({ filter: /^\.\.\/\.\.\/src\// }, args => {
        const file = path.resolve(path.dirname(args.importer), args.path).replace(path.join(root, 'src'), path.join(baseline, 'src'));
        return { path: ['.tsx', '.ts'].map(ext => file + ext).find(fs.existsSync) };
      });
    } }], logLevel: 'warning' });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? fs.readFileSync(path.join(out, 'bundle.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, records = [], errors = [], failures = [], captures = { light: [], dark: [] };
  let browser, page;
  const launch = () => chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox', '--renderer-process-limit=2'] });
  const id = name => page.getByTestId(name);
  // Tall enough for 내 순위 at 320dp with 2× text and a long nickname: element
  // screenshots taller than the viewport come out blank below the scroll view.
  const visit = async (mode, palette, query, width, deviceScaleFactor = 1) => {
    if (page) await page.context().close();
    // 내 순위's spotlight holds still (reduced motion: a still beam and floor glow, no drop-in), so
    // layout and two-capture contrast are measured on a settled card; rankingSpotlightBrowser.cjs checks the motion.
    page = await browser.newPage({ viewport: { width, height: 1600 }, deviceScaleFactor, reducedMotion: 'reduce' });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    await page.addInitScript(({ mode, palette }) => {
      localStorage.setItem('trading-app:appearance', mode); localStorage.setItem('trading-app:financial-colors', palette);
      const epoch = Date.now(), origin = performance.now(); Date.now = () => epoch + Math.round(performance.now() - origin);
    }, { mode, palette });
    await page.goto(`${base}/?${query}`); await id('ranking-return-row-3').waitFor();
    // 내 순위's tier art: its bands mount after layout; decode the artwork before any screenshot.
    if (await id('ranking-my-tier').count()) await page.locator('[data-testid="home-tier-background-artwork"] image').waitFor({ state: 'attached' });
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll('svg image')].map(image => {
        const im = new Image(); im.src = image.getAttribute('href') ?? image.getAttribute('xlink:href'); return im.decode().catch(() => {});
      }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  };
  // Worst glyph contrast of each `select` text in `el`, from a screenshot with ink and one without (text transparent).
  const textContrast = async (el, hideSelector, select) => {
    const ink = await el.screenshot();
    const hide = await page.addStyleTag({ content: `${hideSelector} [dir="auto"] { color: transparent !important; -webkit-text-fill-color: transparent !important; }` });
    const underlay = await el.screenshot(); await hide.evaluate(node => node.remove());
    return { ink, underlay, contrast: await el.evaluate(async (box, { ink, underlay, select }) => {
      const frame = box.getBoundingClientRect(), contrast = [];
      const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      const pixels = async source => {
        const im = new Image(); im.src = `data:image/png;base64,${source}`; await im.decode();
        const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
        const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0); return { width: c.width, data: ctx.getImageData(0, 0, c.width, c.height).data };
      };
      const fg = await pixels(ink), bg = await pixels(underlay);
      for (const text of box.querySelectorAll(select)) {
        const range = document.createRange(); range.selectNodeContents(text);
        const rgb = getComputedStyle(text).color.match(/[\d.]+/g).slice(0, 3).map(Number), l = lum(rgb); let worst = Infinity, samples = 0;
        for (const r of range.getClientRects()) for (let y = r.top; y < r.bottom; y++) for (let x = r.left; x < r.right; x++) {
          const offset = (Math.floor(y - frame.top) * bg.width + Math.floor(x - frame.left)) * 4;
          const delta = rgb.map((v, c) => v - bg.data[offset + c]), norm = delta.reduce((s, v) => s + v * v, 0);
          const coverage = norm ? delta.reduce((s, v, c) => s + v * (fg.data[offset + c] - bg.data[offset + c]), 0) / norm : 0;
          if (coverage < .5 || coverage > 1.05 || !rgb.every((v, c) => Math.abs(bg.data[offset + c] + delta[c] * coverage - fg.data[offset + c]) <= 5)) continue;
          const b = lum([...bg.data.slice(offset, offset + 3)]); samples++;
          worst = Math.min(worst, (Math.max(l, b) + .05) / (Math.min(l, b) + .05));
        }
        contrast.push({ text: text.textContent, color: getComputedStyle(text).color, ratio: worst, samples });
      }
      return contrast;
    }, { ink: ink.toString('base64'), underlay: underlay.toString('base64'), select }) };
  };
  // 내 순위: left column order and alignment, the emblem column beside it (above it with
  // large text), no clipped glyph, no glyph on the emblem or its name. `mutation`
  // breaks the layout on purpose to prove each detector fires.
  const inspectMyCard = (stacked, mutation = null) => page.evaluate(({ stacked, mutation }) => {
    const rect = el => el.getBoundingClientRect();
    const meets = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
    const inside = (a, b) => a.left >= b.left - .5 && a.right <= b.right + .5 && a.top >= b.top - .5 && a.bottom <= b.bottom + .5;
    const glyphs = el => {
      const found = [], range = document.createRange(), walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) for (let i = 0; i < walk.currentNode.length; i++) {
        if (!walk.currentNode.textContent[i].trim()) continue;
        range.setStart(walk.currentNode, i); range.setEnd(walk.currentNode, i + 1); found.push(...range.getClientRects());
      }
      return found;
    };
    const card = document.querySelector('[data-testid="ranking-my-card"]'), figures = document.querySelector('[data-testid="ranking-my-figures"]');
    if (!card || !figures) return { problems: ['no 내 순위 figures'] };
    const column = figures.parentElement, rank = document.querySelector('[data-testid="ranking-my-rank"]');
    const emblem = card.querySelector('[data-testid^="home-emblem-"]'), caption = card.querySelector('[data-testid="ranking-my-tier"]');
    const undo = [], restyle = (el, style) => {
      const before = el.getAttribute('style');
      undo.push(() => (before === null ? el.removeAttribute('style') : el.setAttribute('style', before)));
      Object.assign(el.style, style);
    };
    if (mutation === 'intrude') restyle(figures, { marginLeft: `${rect(column).width - 30}px`, width: '160px' });
    if (mutation === 'clip') for (const el of figures.querySelectorAll('[dir="auto"]')) restyle(el, { whiteSpace: 'nowrap', overflowWrap: 'normal', fontSize: '40px' });
    if (mutation === 'order') { column.insertBefore(figures, column.firstElementChild); undo.push(() => column.appendChild(figures)); }
    if (mutation === 'center') { for (const el of figures.children) restyle(el, { justifyContent: 'center' }); restyle(rank, { textAlign: 'center' }); }
    const problems = [];
    try {
      const k = rect(card), info = rect(column);
      // Top to bottom: profile (when /me answered), 내 순위, the rank, 수익률, 총자산; all from the column's left edge.
      const parts = [['profile', column.firstElementChild.contains(document.querySelector('[data-testid="ranking-my-avatar"]')) ? column.firstElementChild : null],
        ['label', rank.previousElementSibling], ['rank', rank], ['return', figures.children[0]], ['total', figures.children[1]]].filter(([, el]) => el);
      for (let i = 1; i < parts.length; i++) {
        if (rect(parts[i][1]).top < rect(parts[i - 1][1]).bottom - .5) problems.push(`order: ${parts[i][0]} above ${parts[i - 1][0]}`);
      }
      // Each part starts on the column's left edge: the avatar, or the text's first glyph.
      const start = (name, el) => name === 'profile' ? rect(document.querySelector('[data-testid="ranking-my-avatar"]')).left : glyphs(el)[0]?.left;
      for (const [name, el] of parts) if (!(Math.abs(start(name, el) - info.left) <= .5)) problems.push(`${name} not at the left edge`);
      if (rank.previousElementSibling.textContent !== '내 순위') problems.push('내 순위 label');
      // Nothing clipped by the card (it hides overflow) or the screen.
      const all = glyphs(card);
      if (all.some(g => !inside(g, k) || g.right > innerWidth + .5)) problems.push('clipped');
      if (glyphs(column).some(g => !inside(g, info))) problems.push('a glyph leaves the information column');
      if (emblem) {
        const e = rect(emblem), c = rect(caption);
        if (glyphs(column).some(g => meets(g, e) || meets(g, c))) problems.push('a glyph meets the emblem or its name');
        if (stacked ? e.bottom > info.top + .5 : e.left < info.right - .5) problems.push(stacked ? 'emblem not above' : 'emblem not beside');
        if (!inside(e, k) || !inside(c, k)) problems.push('emblem cut');
      }
      return { problems, texts: [document.querySelector('[data-testid="ranking-my-return"]').textContent,
        document.querySelector('[data-testid="ranking-my-total"]').textContent, rank.textContent] };
    } finally { undo.reverse().forEach(restore => restore()); }
  }, { stacked, mutation });
  // The header and the rows never overlap; the slot sits on the screen, not on a card.
  const inspectStack = () => page.evaluate(() => {
    const rect = el => el.getBoundingClientRect(), problems = [];
    const stack = ['ranking-my-card', 'ranking-slot', 'ranking-tabs'].map(name => document.querySelector(`[data-testid="${name}"]`)).filter(Boolean)
      .concat([...document.querySelectorAll('[data-testid^="ranking-item-row-"]')]);
    for (let i = 1; i < stack.length; i++) if (rect(stack[i]).top < rect(stack[i - 1]).bottom - .5) problems.push(`${stack[i].dataset.testid} overlaps ${stack[i - 1].dataset.testid}`);
    const slot = document.querySelector('[data-testid="ranking-slot"]');
    if (slot) {
      const style = getComputedStyle(slot);
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.borderTopWidth !== '0px' || style.boxShadow !== 'none') problems.push('slot has a card');
    }
    return problems;
  });
  try {
    browser = await launch(); let visits = 0;
    for (const mode of modes) for (const width of widths)
    for (const fontScale of scales) for (const long of (quick ? [false] : [false, true]))
    for (const palette of (quick ? ['red_blue'] : ['red_blue', 'green_red'])) for (const tier of tiers) {
      if (++visits % 56 === 0) { if (page) { await page.context().close(); page = null; } await browser.close(); browser = await launch(); }
      const myReturn = MY_RETURNS[(tiers.indexOf(tier) + (long ? 1 : 0) + (palette === 'green_red' ? 2 : 0)) % MY_RETURNS.length];
      await visit(mode, palette, `tier=${tier}&fontScale=${fontScale}&long=${long ? 1 : 0}&myReturn=${myReturn}${long ? '' : `&myTotal=${MY_TOTAL}`}`, width);
      const info = { mode, width, fontScale, long, palette, tier, myReturn }, layouts = [];
      const rowTotal = i => i === 2 && !long ? '10,450,000원' : long ? LONG_TOTAL : '123,456,789원';
      for (let i = 0; i < 4; i++) {
        const row = id(`ranking-item-row-${i}`); await row.scrollIntoViewIfNeeded();
        const { ink, underlay, contrast } = await textContrast(row, '[data-testid^="ranking-item-"]',
          '[data-testid^="ranking-return-"], [data-testid^="ranking-total-"]');
        const layout = await row.evaluate(el => {
          const box = el.getBoundingClientRect(), clipped = [], overlaps = [], glyphs = [];
          const plate = getComputedStyle(el.querySelector('[data-testid^="ranking-figures-"]')), card = getComputedStyle(el);
          for (const text of el.querySelectorAll('[dir="auto"]')) {
            const range = document.createRange(), walk = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
            while (walk.nextNode()) for (let j = 0; j < walk.currentNode.length; j++) {
              if (!walk.currentNode.textContent[j].trim()) continue;
              range.setStart(walk.currentNode, j); range.setEnd(walk.currentNode, j + 1);
              for (const r of range.getClientRects()) {
                if (r.left < box.left - .5 || r.right > box.right + .5 || r.top < box.top - .5 || r.bottom > box.bottom + .5) clipped.push(text.textContent);
                glyphs.push({ r, owner: text });
              }
            }
          }
          for (let a = 0; a < glyphs.length; a++) for (let b = a + 1; b < glyphs.length; b++) {
            const x = glyphs[a], y = glyphs[b]; if (x.owner === y.owner) continue;
            if (x.r.left < y.r.right - .5 && x.r.right > y.r.left + .5 && x.r.top < y.r.bottom - .5 && x.r.bottom > y.r.top + .5) { overlaps.push([x.owner.textContent, y.owner.textContent]); break; }
          }
          // The row's small emblem: inside the card and clear of every glyph.
          const emblem = el.querySelector('[data-testid^="ranking-row-emblem-image-"]')?.getBoundingClientRect();
          const emblemProblems = !emblem ? [] : [
            ...(emblem.left < box.left - .5 || emblem.right > box.right + .5 || emblem.top < box.top - .5 || emblem.bottom > box.bottom + .5 ? ['emblem cut'] : []),
            ...(glyphs.some(({ r }) => r.left < emblem.right - .5 && r.right > emblem.left + .5 && r.top < emblem.bottom - .5 && r.bottom > emblem.top + .5) ? ['emblem meets text'] : []),
          ];
          return { clipped, overlaps: overlaps.slice(0, 2), height: box.height, width: box.width, emblem: !!emblem, emblemProblems,
            plate: { background: plate.backgroundColor, radius: plate.borderRadius, border: plate.borderWidth, shadow: plate.boxShadow },
            card: [card.backgroundColor, card.borderTopColor, card.borderTopWidth, card.borderTopLeftRadius, card.boxShadow],
            art: el.querySelectorAll('svg, [data-testid^="ranking-tier-background-"]').length,
            texts: [el.querySelector('[data-testid^="ranking-return-"]').textContent, el.querySelector('[data-testid^="ranking-total-"]').textContent],
            emblemCount: el.querySelectorAll('[data-testid^="home-emblem-"]').length };
        });
        layout.contrast = contrast;
        // Collect independent layout failures, but fail the entire suite below.
        // This leaves screenshots/results for diagnosis instead of losing them.
        try {
        assert.deepEqual(layout.clipped, [], JSON.stringify(info)); assert.deepEqual(layout.overlaps, [], JSON.stringify(info)); assert.equal(layout.emblemCount, 0);
        assert.equal(layout.texts[0], ['+123.45%', '-12.34%', rateText(myReturn), '-'][i]);
        assert.equal(layout.texts[1], rowTotal(i));
        if (!baseline) {
          assert.equal(layout.plate.background, 'rgba(0, 0, 0, 0)'); assert.equal(layout.plate.radius, '0px'); assert.equal(layout.plate.border, '0px'); assert.equal(layout.plate.shadow, 'none');
          assert.ok(layout.contrast.every(c => c.samples > 0 && c.ratio >= 4.5), JSON.stringify({ ...info, contrast: layout.contrast }));
          // Every tier: the same plain card, no artwork; the tier stays as a small emblem.
          assert.deepEqual(layout.card, [...CARD[mode], '1px', '14px', 'none'], JSON.stringify(info));
          assert.equal(layout.art, 0, 'no row artwork');
          assert.equal(layout.emblem, tier !== 'unknown');
          assert.deepEqual(layout.emblemProblems, [], JSON.stringify(info));
        }
        } catch (error) {
          if (!failures.length) { fs.writeFileSync(path.join(out, 'failure-row.png'), ink); fs.writeFileSync(path.join(out, 'failure-underlay.png'), underlay); }
          failures.push({ ...info, row: i, message: error.message });
        }
        layouts.push(layout);
      }
      let myCard = null;
      if (!baseline) {
        await page.evaluate(() => document.querySelector('[data-testid="ranking-screen"]').scrollTo(0, 0));
        myCard = await inspectMyCard(fontScale > 1.3);
        // The figures and their labels on this card (art or plain) at this size.
        myCard.contrast = (await textContrast(id('ranking-my-card'), '[data-testid="ranking-my-card"]', '[data-testid="ranking-my-figures"] [dir="auto"]')).contrast;
        const stack = await inspectStack();
        const expected = [rateText(myReturn), long ? LONG_TOTAL : '10,450,000원', '#3'];
        const legible = myCard.contrast.length === 4 && myCard.contrast.every(c => c.samples > 0 && c.ratio >= 4.5);
        if (myCard.problems.length || stack.length || !legible || JSON.stringify(myCard.texts) !== JSON.stringify(expected)) {
          failures.push({ ...info, myCard: myCard.problems, stack, texts: myCard.texts, expected, ...(legible ? {} : { contrast: myCard.contrast }) });
        }
      }
      records.push({ ...info, layouts, myCard });
      if (width === 390 && fontScale === 1 && !long && palette === 'red_blue' && tier !== 'unknown') {
        const my = await id('ranking-my-card').screenshot(), row = await id('ranking-item-row-0').screenshot();
        fs.writeFileSync(path.join(out, `${tier}-${mode}-my.png`), my); fs.writeFileSync(path.join(out, `${tier}-${mode}-row.png`), row);
        captures[mode].push({ name: tier === 'master' ? 'Whale' : tier, my: my.toString('base64'), row: row.toString('base64') });
        if (tier === 'master') await page.screenshot({ path: path.join(out, `whale-${mode}-screen.png`), clip: { x: 0, y: 0, width, height: 900 } });
      }
      if (long && width === 320 && fontScale === 2 && palette === 'green_red' && ['diamond', 'master'].includes(tier)) await page.screenshot({ path: path.join(out, `${tier}-${mode}-320-large-long.png`), fullPage: true });
      if (visits % 56 === 0) console.log(`checked ${visits} layouts`);
    }
    for (const mode of modes) {
      if (!captures[mode].length) continue;
      const encoded = await page.evaluate(async ({ entries, mode }) => {
        const c = document.createElement('canvas'); c.width = 820; c.height = entries.length * 290;
        const ctx = c.getContext('2d'); ctx.fillStyle = mode === 'dark' ? '#15171c' : '#fcfcfd'; ctx.fillRect(0, 0, c.width, c.height);
        for (let i = 0; i < entries.length; i++) {
          ctx.fillStyle = mode === 'dark' ? '#ffffff' : '#202a35'; ctx.font = '16px sans-serif'; ctx.fillText(`${entries[i].name} / ${mode} · My standing / Ranking row`, 14, i * 290 + 24);
          for (const [key, x] of [['my', 14], ['row', 425]]) { const im = new Image(); im.src = `data:image/png;base64,${entries[i][key]}`; await im.decode(); ctx.drawImage(im, x, i * 290 + 40); }
        }
        return c.toDataURL('image/png').split(',')[1];
      }, { entries: captures[mode], mode });
      fs.writeFileSync(path.join(out, `comparison-${mode}.png`), Buffer.from(encoded, 'base64'));
    }
    if (!baseline) {
      await visit('dark', 'green_red', 'tier=master&final=1', 390);
      await id('home-tier-background-whale-dark').waitFor(); await id('ranking-my-settled').waitFor(); await id('ranking-tab-friends').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid^="ranking-item-row-"]').length === 1);
      await id('ranking-tab-top10').click(); await id('ranking-return-row-3').waitFor();
      const requests = await page.evaluate(() => window.fixture.transport.requests);
      assert.ok(requests.some(r => r.includes('scope=friends') && r.includes('rankType=final')));
      assert.ok(requests.some(r => r.includes('scope=top10') && r.includes('limit=10') && r.includes('rankType=final')));
      const row = id('ranking-item-row-0');
      for (const reducedMotion of ['no-preference', 'reduce']) {
        await page.emulateMedia({ reducedMotion }); await row.scrollIntoViewIfNeeded(); const box = await row.boundingBox();
        await page.mouse.move(box.x + 30, box.y + 25); await page.mouse.down(); await page.waitForTimeout(220);
        // The shared ink is the card's first layer (nothing is painted beneath it now).
        const heldInk = await row.evaluate(el => {
          const layer = el.firstElementChild, ink = layer.firstElementChild;
          return { art: el.querySelectorAll('svg').length, layer: getComputedStyle(layer).position, opacity: Number(getComputedStyle(ink).opacity) };
        });
        assert.deepEqual([heldInk.art, heldInk.layer], [0, 'absolute'], 'ink layer over the plain card');
        assert.ok(heldInk.opacity > 0, 'touch ink is visible while held');
        assert.deepEqual(await row.boundingBox(), box, 'touch keeps row and border bounds stable'); await page.mouse.up(); await page.waitForTimeout(250);
      }
      await row.click(); assert.deepEqual(await page.evaluate(() => window.lastNavigation), ['UserSeasonSummary', { userId: 'row-0' }]);

      // 내 행 (나 칩·링) and the tier line (2026-10-15). row-2 (sp-2) is mine.
      // `mutation` breaks the layout on purpose to prove each detector fires.
      const inspectMyRow = (mutation = null) => page.evaluate(mutation => {
        const rect = el => el.getBoundingClientRect();
        const meets = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
        const inside = (a, b) => a.left >= b.left - .5 && a.right <= b.right + .5 && a.top >= b.top - .5 && a.bottom <= b.bottom + .5;
        const glyphs = el => {
          const found = [], range = document.createRange(), walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          while (walk.nextNode()) for (let i = 0; i < walk.currentNode.length; i++) {
            if (!walk.currentNode.textContent[i].trim()) continue;
            range.setStart(walk.currentNode, i); range.setEnd(walk.currentNode, i + 1); found.push(...range.getClientRects());
          }
          return found;
        };
        const rows = [...document.querySelectorAll('[data-testid^="ranking-item-row-"]')];
        const rings = document.querySelectorAll('[data-testid="ranking-me-ring"]'), chips = document.querySelectorAll('[data-testid="ranking-me-chip"]');
        if (rings.length !== 1 || chips.length !== 1) return { problems: [`${chips.length} chips, ${rings.length} rings`], rows: [] };
        const ring = rings[0], chip = chips[0], row = ring.closest('[data-testid^="ranking-item-row-"]');
        const nameLine = chip.parentElement.parentElement, name = [...nameLine.children].find(child => !child.contains(chip));
        const undo = [], restyle = (el, style) => {
          const before = el.getAttribute('style');
          undo.push(() => (before === null ? el.removeAttribute('style') : el.setAttribute('style', before)));
          Object.assign(el.style, style);
        };
        if (mutation === 'nowrap') for (const el of [nameLine, ...nameLine.querySelectorAll('*')]) restyle(el, { whiteSpace: 'nowrap' });
        if (mutation === 'ringInset') restyle(ring, { top: '0px', right: '0px', bottom: '0px', left: '0px' });
        const problems = [];
        try {
          if (chip.closest('[data-testid^="ranking-item-row-"]') !== row || row.dataset.testid !== 'ranking-item-row-2') problems.push('chip/ring not on my row');
          const r = rect(row), g = rect(ring), c = rect(chip), screen = document.querySelector('[data-testid="ranking-screen"]');
          // The ring: 2 wide, 3 clear of the card's border on every side, inside the list padding, clear of the neighbours.
          const outset = [r.left - g.left, g.right - r.right, r.top - g.top, g.bottom - r.bottom];
          if (outset.some(value => Math.abs(value - 5) > .5)) problems.push(`ring outset ${outset.map(v => v.toFixed(1)).join('/')}`);
          for (const other of rows) if (other !== row && meets(g, rect(other))) problems.push(`ring meets ${other.dataset.testid}`);
          if (g.left < rect(screen).left - .5 || g.right > rect(screen).right + .5) problems.push('ring cut at the screen edge');
          // No sideways scroll; nothing but the ring leaves a row; every glyph stays in its row.
          if (document.scrollingElement.scrollWidth > innerWidth || screen.scrollWidth > screen.clientWidth + .5) problems.push('sideways scroll');
          for (const each of rows) {
            const box = rect(each);
            const out = [...each.querySelectorAll('*')].find(el => el !== ring && !ring.contains(el) && rect(el).width
              && (rect(el).left < box.left - .5 || rect(el).right > box.right + .5));
            if (out) problems.push(`${each.dataset.testid} overflows (${out.dataset.testid ?? out.textContent.slice(0, 12)})`);
            if (glyphs(each).some(glyph => !inside(glyph, box))) problems.push(`${each.dataset.testid} clips text`);
          }
          // Chip, nickname and tier line never overlap; the chip keeps its glyph.
          if (glyphs(name).some(glyph => meets(glyph, c))) problems.push('nickname under the chip');
          if (glyphs(chip).some(glyph => !inside(glyph, c))) problems.push('chip clips its glyph');
          const tierLine = row.querySelector('[data-testid^="ranking-row-tier-"]');
          if (tierLine && (meets(rect(tierLine), rect(nameLine)) || glyphs(name).some(glyph => meets(glyph, rect(tierLine))))) problems.push('tier line meets the nickname line');
        } finally { undo.reverse().forEach(restore => restore()); }
        return { problems, rows: rows.map(each => [rect(each).top, rect(each).height, rect(each).left, rect(each).width]) };
      }, mutation);

      // Detectors first: each deliberate break must be reported, then the page is restored.
      await visit('light', 'red_blue', 'tier=gold&fontScale=2&long=1', 320);
      const controls = { nowrap: await inspectMyRow('nowrap'), ringInset: await inspectMyRow('ringInset'), restored: await inspectMyRow() };
      console.log('negative controls', JSON.stringify({ nowrap: controls.nowrap.problems, ringInset: controls.ringInset.problems }));
      if (!controls.nowrap.problems.some(problem => /chip|clips text|overflows/.test(problem))) failures.push({ control: 'nowrap', message: 'detector did not fire' });
      if (!controls.ringInset.problems.some(problem => problem.startsWith('ring outset'))) failures.push({ control: 'ringInset', message: 'detector did not fire' });
      if (controls.restored.problems.length) failures.push({ control: 'restored', message: controls.restored.problems.join('; ') });
      // 내 순위 detectors, beside the emblem (390, 1×) and under it (320, 2×, long values).
      const cardControls = {};
      for (const [name, query, width, stacked] of [['beside', 'tier=diamond&myReturn=-12.34', 390, false], ['stacked', 'tier=diamond&fontScale=2&long=1&myReturn=-12.34', 320, true]]) {
        await visit('light', 'red_blue', query, width);
        const result = { order: await inspectMyCard(stacked, 'order'), center: await inspectMyCard(stacked, 'center'),
          clip: await inspectMyCard(stacked, 'clip'), restored: await inspectMyCard(stacked) };
        if (!stacked) result.intrude = await inspectMyCard(stacked, 'intrude');
        cardControls[name] = Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.problems]));
        if (!result.order.problems.some(problem => problem.startsWith('order'))) failures.push({ control: `${name} order`, message: 'detector did not fire' });
        // A long total can fill its line, so centring may not move it: the rank and the rate always move.
        if (!['rank', 'return'].every(part => result.center.problems.includes(`${part} not at the left edge`))) failures.push({ control: `${name} center`, message: 'detector did not fire' });
        if (!result.clip.problems.some(problem => /clipped|leaves the information column|meets the emblem/.test(problem))) failures.push({ control: `${name} clip`, message: 'detector did not fire' });
        if (result.intrude && !result.intrude.problems.some(problem => /meets the emblem|leaves the information column/.test(problem))) failures.push({ control: `${name} intrude`, message: 'detector did not fire' });
        if (result.restored.problems.length) failures.push({ control: `${name} restored`, message: result.restored.problems.join('; ') });
      }
      console.log('내 순위 negative controls', JSON.stringify(cardControls));

      const myRows = [];
      for (const mode of ['light', 'dark']) for (const width of [320, 390]) for (const fontScale of [1, 2])
      for (const longName of [false, true]) for (const tier of tiers) {
        const query = `tier=${tier}&fontScale=${fontScale}&long=${longName ? 1 : 0}`, info = { mode, width, fontScale, longName, tier };
        await visit(mode, 'red_blue', query, width);
        const marked = await inspectMyRow();
        await visit(mode, 'red_blue', `${query}&me=none`, width);
        const unmarked = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="ranking-item-row-"]')]
          .map(el => { const box = el.getBoundingClientRect(); return [box.top, box.height, box.left, box.width]; }));
        // Marking my row moves nothing: every row keeps its box.
        const moved = marked.rows.flatMap((box, i) => box.some((value, j) => Math.abs(value - unmarked[i][j]) > .5) ? [`row-${i}`] : []);
        myRows.push({ ...info, problems: marked.problems, moved });
        if (marked.problems.length || moved.length) failures.push({ ...info, problems: marked.problems, moved });
      }
      console.log(`my row: ${myRows.length} layouts, ${myRows.filter(r => r.problems.length || r.moved.length).length} with problems`);

      // 내 순위 figures on every tier's art, both palettes and directions: >= 4.5:1 for the
      // values and their labels (the halo included, as drawn). Large text and long values
      // move the figures down onto other facets of the art.
      const cardContrast = [];
      const contrastSizes = quick ? [[390, 1, false]] : [320, 390, 430].flatMap(width => [1, 2].flatMap(font => [[width, font, false], [width, font, true]]));
      for (const mode of modes) for (const [width, fontScale, long] of contrastSizes) for (const palette of ['red_blue', 'green_red'])
      for (const tier of tiers.filter(t => t !== 'unknown')) for (const myReturn of ['4.5', '-12.34']) {
        await visit(mode, palette, `tier=${tier}&fontScale=${fontScale}&long=${long ? 1 : 0}&myReturn=${myReturn}${long ? '' : `&myTotal=${MY_TOTAL}`}`, width);
        const { ink, contrast } = await textContrast(id('ranking-my-card'), '[data-testid="ranking-my-card"]', '[data-testid="ranking-my-figures"] [dir="auto"]');
        const info = { mode, width, fontScale, long, palette, tier, myReturn };
        cardContrast.push({ ...info, contrast });
        if (contrast.length !== 4 || !contrast.every(c => c.samples > 0 && c.ratio >= 4.5)) {
          failures.push({ ...info, cardContrast: contrast });
          fs.writeFileSync(path.join(out, `failure-card-${mode}-${width}-${fontScale}x${long ? '-long' : ''}-${palette}-${tier}-${myReturn}.png`), ink);
        }
      }
      console.log(`내 순위 contrast: ${cardContrast.length} cards, worst ${Math.min(...cardContrast.flatMap(c => c.contrast.map(x => x.ratio))).toFixed(2)}:1`);

      // Screenshots: an ordinary row and my row (ring included) for every tier in both modes.
      const shots = { light: [], dark: [] };
      for (const mode of ['light', 'dark']) for (const tier of tiers) {
        await visit(mode, 'red_blue', `tier=${tier}&fontScale=1&long=0`, 390, 2);
        const around = async name => { const box = await id(name).boundingBox(); return page.screenshot({ clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 } }); };
        const other = await around('ranking-item-row-1'), mine = await around('ranking-item-row-2');
        fs.writeFileSync(path.join(out, `row-${tier}-${mode}.png`), other); fs.writeFileSync(path.join(out, `mine-${tier}-${mode}.png`), mine);
        shots[mode].push({ name: tier === 'master' ? 'Whale' : tier, other: other.toString('base64'), mine: mine.toString('base64') });
      }
      for (const mode of ['light', 'dark']) {
        const encoded = await page.evaluate(async ({ entries, mode }) => {
          const images = await Promise.all(entries.map(async entry => Promise.all([entry.other, entry.mine].map(async source => {
            const im = new Image(); im.src = `data:image/png;base64,${source}`; await im.decode(); return im; }))));
          const c = document.createElement('canvas'); c.width = images[0][0].width * 2 + 30; c.height = images.reduce((sum, pair) => sum + pair[1].height + 40, 0);
          const ctx = c.getContext('2d'); ctx.fillStyle = mode === 'dark' ? '#15171c' : '#fcfcfd'; ctx.fillRect(0, 0, c.width, c.height);
          let y = 0;
          for (const [i, [other, mine]] of images.entries()) {
            ctx.fillStyle = mode === 'dark' ? '#ffffff' : '#202a35'; ctx.font = '22px sans-serif'; ctx.fillText(`${entries[i].name} / ${mode} · other row / my row`, 10, y + 28);
            ctx.drawImage(other, 0, y + 40); ctx.drawImage(mine, other.width + 30, y + 40); y += mine.height + 40;
          }
          return c.toDataURL('image/png').split(',')[1];
        }, { entries: shots[mode], mode });
        fs.writeFileSync(path.join(out, `my-row-comparison-${mode}.png`), Buffer.from(encoded, 'base64'));
      }

      // 순위 안내 with all five messages, on the screen without a card: height steady through
      // transitions, nothing clipped or under the dots, shorter messages centred in the
      // 3-line height of 어제보다, the glyph on the list's left edge, the dots inside it.
      const slots = [];
      const expected = { above: '바로 위 hana', first: '1위 demiant', tier: 'Platinum 티어까지', goal: '본전까지', change: '순위 4계단 상승' };
      const slotSizes = quick ? [[320, 2], [390, 1]] : [320, 360, 390, 430].flatMap(width => [[width, 1], [width, 2]]);
      for (const mode of ['light', 'dark']) for (const [width, fontScale] of slotSizes) for (const slotLong of [0, 1]) {
        const info = { mode, width, fontScale, slotLong };
        await visit(mode, 'red_blue', `slot=5&fontScale=${fontScale}&slotLong=${slotLong}`, width, 2);
        await page.waitForFunction(() => document.querySelectorAll('[data-testid^="ranking-slot-dot-"]').length === 5);
        const stack = await inspectStack();
        if (stack.length) failures.push({ slot: info, stack });
        const height = () => id('ranking-slot').evaluate(el => el.getBoundingClientRect().height);
        const heights = [await height()], images = [], states = [];
        for (const key of Object.keys(expected)) {
          if (key !== 'above') {
            await id(`ranking-slot-dot-${key}`).click();
            for (let i = 0; i < 10; i++) { heights.push(await height()); await page.waitForTimeout(50); }
          }
          await page.waitForTimeout(350);
          const state = await page.evaluate(() => {
            const rect = el => el.getBoundingClientRect(), meets = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
            const slot = document.querySelector('[data-testid="ranking-slot"]'), stage = document.querySelector('[data-testid="ranking-slot-stage"]');
            const message = document.querySelector('[data-testid="ranking-slot-message"]'), dots = document.querySelector('[data-testid="ranking-slot-dot-above"]').parentElement;
            const list = document.querySelector('[data-testid="ranking-my-card"]');
            const k = rect(slot), s = rect(stage), m = rect(message), d = rect(dots), glyphs = [], range = document.createRange();
            const circle = message.firstElementChild.firstElementChild, glyph = rect(circle), edge = rect(list);
            const walk = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
            // The circle's mark is capped at 1.2× (maxFontSizeMultiplier), which this web shim
            // ignores: check the circle itself instead of its uncapped glyphs.
            while (walk.nextNode()) for (let i = 0; i < walk.currentNode.length; i++) {
              if (!walk.currentNode.textContent[i].trim() || circle.contains(walk.currentNode)) continue;
              range.setStart(walk.currentNode, i); range.setEnd(walk.currentNode, i + 1); glyphs.push(...range.getClientRects());
            }
            return { text: message.textContent, opacity: Number(getComputedStyle(message).opacity),
              clipped: [...glyphs, glyph].filter(g => g.left < k.left - .5 || g.right > k.right + .5 || g.top < k.top - .5 || g.bottom > k.bottom + .5).length,
              onDots: glyphs.filter(g => meets(g, d)).length, offCenter: Math.abs((m.top + m.bottom) / 2 - (s.top + s.bottom) / 2),
              stage: s.height, message: m.height, card: k.height,
              edges: [glyph.left - edge.left, edge.right - d.right] };
          });
          states.push({ key, ...state });
          images.push((await id('ranking-slot').screenshot()).toString('base64'));
          const problems = [];
          if (!state.text.includes(expected[key]) || state.opacity !== 1) problems.push(`shows ${state.text}`);
          if (state.clipped || state.onDots) problems.push(`clipped ${state.clipped}, on dots ${state.onDots}`);
          if (state.offCenter > 1) problems.push(`off centre by ${state.offCenter.toFixed(1)}`);
          // The glyph starts where the cards start; the dots stay within the list's width.
          if (Math.abs(state.edges[0]) > .5 || state.edges[1] < -.5) problems.push(`edges ${state.edges.map(v => v.toFixed(1)).join('/')}`);
          if (problems.length) failures.push({ slot: info, key, problems });
        }
        const spread = Math.max(...heights) - Math.min(...heights), tallest = Math.max(...states.map(state => state.message));
        if (spread > .5) failures.push({ slot: info, message: `slot height moved by ${spread}` });
        // The stage is the tallest message's height; with short names that is the 3-line 어제보다.
        if (states.some(state => Math.abs(state.stage - tallest) > .5)) failures.push({ slot: info, message: 'stage is not the tallest message' });
        if (!slotLong && Math.abs(states.find(state => state.key === 'change').message - tallest) > .5) {
          failures.push({ slot: info, message: '어제보다 is not the tallest message' });
        }
        slots.push({ ...info, samples: heights.length, spread, states });
        const encoded = await page.evaluate(async ({ images, mode }) => {
          const decoded = await Promise.all(images.map(async source => { const im = new Image(); im.src = `data:image/png;base64,${source}`; await im.decode(); return im; }));
          const c = document.createElement('canvas'); c.width = decoded[0].width + 20; c.height = decoded.reduce((sum, im) => sum + im.height + 20, 0);
          const ctx = c.getContext('2d'); ctx.fillStyle = mode === 'dark' ? '#15171c' : '#fcfcfd'; ctx.fillRect(0, 0, c.width, c.height);
          let y = 10; for (const im of decoded) { ctx.drawImage(im, 10, y); y += im.height + 20; }
          return c.toDataURL('image/png').split(',')[1];
        }, { images, mode });
        fs.writeFileSync(path.join(out, `slot-${mode}-${width}-${fontScale}x${slotLong ? '-long' : ''}.png`), Buffer.from(encoded, 'base64'));
      }
      console.log(`slot: ${slots.length} layouts, height spread max ${Math.max(...slots.map(slot => slot.spread))}`);
      fs.writeFileSync(path.join(out, 'my-row-results.json'), JSON.stringify({ controls, cardControls, myRows, cardContrast, slots }, null, 2));
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ baseline: baseline ?? null, layouts: records.length, rows: records.length * 4, records, errors, failures }, null, 2));
    assert.equal(failures.length, 0, JSON.stringify(failures.slice(0, 10)));
    console.log(`PASS ${records.length} layouts / ${records.length * 4} rows; ${out}`);
  } finally { if (browser) await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
