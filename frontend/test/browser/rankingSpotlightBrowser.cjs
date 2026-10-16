// 내 순위 spotlight (2026-10-16): the actual RankingScreen over the ranking fixtures, the
// tab's focus in the check's hands (rankingSpotlightFixture.jsx) and Playwright's fake clock,
// so the entrance starts at a known instant and every capture is deterministic.
//
// - Every layout (6 tiers × Light/Dark × 320/390 × text 1/2×) is compared with a HEAD copy
//   (RANKING_SPOTLIGHT_BASELINE_SOURCE, a directory holding `src/`): the card's size and every
//   text, the avatar, the emblem slot, its image and the tier name sit exactly where they did.
//   Nothing changes outside the card's rounded edge, nothing scrolls sideways, and no text's
//   contrast drops below 4.5:1 (3:1 for the 32px rank) because of the light.
// - Reduced motion: only a still beam and floor glow; nothing changes over time.
// - The entrance (390, 1×, every tier and mode) at the mock-up's frame times, plus refocus,
//   remount and Light/Dark without a replay.
// - RANKING_SPOTLIGHT_REFERENCE (optional) points at the mock-up PNGs for side-by-side sheets.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.RANKING_SPOTLIGHT_OUTPUT ?? '/tmp/trading-ranking-spotlight';
const baseline = process.env.RANKING_SPOTLIGHT_BASELINE_SOURCE;
const reference = process.env.RANKING_SPOTLIGHT_REFERENCE;
const quick = process.env.RANKING_SPOTLIGHT_QUICK === '1';
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master'];
const MODES = ['light', 'dark'];
const WIDTHS = quick ? [390] : [320, 390];
const SCALES = quick ? [1] : [1, 2];
const FRAMES = [60, 200, 330, 420, 520, 700, 1000];
const STEADY = 3000;
const name = tier => (tier === 'master' ? 'whale' : tier);
const stage = require(path.join(root, 'src/screens/home/tierStage.ts'));

async function build(outfile, source) {
  await esbuild.build({ entryPoints: [path.join(__dirname, 'rankingSpotlightFixture.jsx')], outfile,
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'ranking-spotlight-fixtures', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks)$/ }, () => ({ path: path.join(__dirname, 'rankingTierMocks.js') }));
      if (source) b.onResolve({ filter: /^\.\.\/\.\.\/src\// }, args => {
        const file = path.resolve(path.dirname(args.importer), args.path).replace(path.join(root, 'src'), path.join(source, 'src'));
        return { path: ['.tsx', '.ts', '.jsx', '.js'].map(ext => file + ext).find(fs.existsSync) };
      });
    } }], logLevel: 'warning' });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  if (!baseline) throw Error('RANKING_SPOTLIGHT_BASELINE_SOURCE (a HEAD copy holding src/) is required for the layout comparison');
  await build(path.join(out, 'current.js'));
  await build(path.join(out, 'baseline.js'), baseline);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (url.pathname.endsWith('.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(out, path.basename(url.pathname)))); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/${url.searchParams.get('bundle') === 'baseline' ? 'baseline' : 'current'}.js"></script>`);
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const failures = [], errors = [], records = { layouts: [], reduced: [], entrance: [], flows: [] };
  const fail = (info, message) => failures.push({ ...info, message });
  const launch = () => chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox', '--renderer-process-limit=2'] });
  let browser = await launch(), opened = 0;

  // A page frozen right before the tab gains focus: the entrance (and every loop) starts at `focus()`.
  async function open({ bundle = 'current', tier, mode, width = 390, fontScale = 1, reduced = false, scale = 2, focused = false }) {
    if (++opened % 40 === 0) { await browser.close(); browser = await launch(); }
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: scale, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${bundle} ${tier} ${mode}: ${e.message}`));
    await page.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    await page.addInitScript(mode => {
      localStorage.setItem('trading-app:appearance', mode); localStorage.setItem('trading-app:financial-colors', 'red_blue');
    }, mode);
    await page.clock.install({ time: new Date('2026-10-16T00:00:00Z') });
    await page.goto(`${base}/?bundle=${bundle}&tier=${tier}&fontScale=${fontScale}&myReturn=4.5&myTotal=10450000${focused ? '' : '&focused=0'}`);
    await page.getByTestId('ranking-return-row-3').waitFor();
    await page.locator('[data-testid="home-tier-background-artwork"] image').waitFor({ state: 'attached' });
    if (bundle === 'current') await page.getByTestId('tier-stage-floor').waitFor({ state: 'attached' });
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll('svg image, img')].map(image => {
        const im = new Image(); im.src = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? image.src; return im.decode().catch(() => {});
      }));
      await document.fonts.ready;
    });
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 500);
    await page.waitForTimeout(80);
    const settle = () => page.waitForTimeout(60);
    return { page, context, settle,
      focus: async (next = true) => { await page.evaluate(next => window.fixture.focus(next), next); await settle(); },
      run: async ms => { await page.clock.runFor(ms); await settle(); },
      close: () => context.close() };
  }

  // Layout boxes inside the card, measured without the spotlight's transforms.
  const inspect = page => page.evaluate(() => {
    const card = document.querySelector('[data-testid="ranking-my-card"]');
    const moving = [...card.querySelectorAll('*')].filter(el => el.style.transform);
    const saved = moving.map(el => el.style.transform);
    moving.forEach(el => { el.style.transform = 'none'; });
    try {
      const k = card.getBoundingClientRect();
      const box = el => { const r = el.getBoundingClientRect(); return [r.left - k.left, r.top - k.top, r.width, r.height].map(v => +v.toFixed(3)); };
      const slot = card.querySelector('[data-testid="tier-card-emblem"]') ?? card.querySelector('[data-testid^="home-emblem-"]');
      const texts = [...card.querySelectorAll('[dir="auto"]')].map(el => ({ text: el.textContent, box: box(el) }));
      return {
        card: [k.width, k.height].map(v => +v.toFixed(3)),
        boxes: { avatar: box(card.querySelector('[data-testid="ranking-my-avatar"]')), slot: box(slot),
          image: box(card.querySelector('[data-testid="home-tier-image"]')), caption: box(card.querySelector('[data-testid="ranking-my-tier"]')) },
        texts,
        overflow: document.scrollingElement.scrollWidth > innerWidth || [...document.querySelectorAll('[data-testid="ranking-screen"]')].some(el => el.scrollWidth > el.clientWidth + .5),
        clip: { overflow: getComputedStyle(card).overflow, radius: getComputedStyle(card).borderTopLeftRadius },
      };
    } finally { moving.forEach((el, i) => { el.style.transform = saved[i]; }); }
  });

  // Worst glyph contrast of each text in the card: a capture with ink and one with the text
  // transparent (the clock is paused, so both captures show the same light).
  const contrast = async (page, scale) => {
    const card = page.getByTestId('ranking-my-card');
    const ink = await card.screenshot();
    // The text's own halo stays in the underlay: it is part of what the glyphs sit on.
    const hide = await page.addStyleTag({ content: '[data-testid="ranking-my-card"] [dir="auto"] { color: transparent !important; -webkit-text-fill-color: transparent !important; }' });
    const underlay = await card.screenshot(); await hide.evaluate(node => node.remove());
    return card.evaluate(async (box, { ink, underlay, scale }) => {
      const frame = box.getBoundingClientRect(), results = [];
      const lum = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      const pixels = async source => {
        const im = new Image(); im.src = `data:image/png;base64,${source}`; await im.decode();
        const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
        const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0); return { width: c.width, data: ctx.getImageData(0, 0, c.width, c.height).data };
      };
      const fg = await pixels(ink), bg = await pixels(underlay);
      for (const text of box.querySelectorAll('[dir="auto"]')) {
        if (!text.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        const rgb = getComputedStyle(text).color.match(/[\d.]+/g).slice(0, 3).map(Number), l = lum(rgb);
        let worst = Infinity, samples = 0;
        for (const r of range.getClientRects()) for (let y = Math.ceil((r.top - frame.top) * scale); y < (r.bottom - frame.top) * scale; y++) {
          for (let x = Math.ceil((r.left - frame.left) * scale); x < (r.right - frame.left) * scale; x++) {
            const offset = (y * bg.width + x) * 4;
            const delta = rgb.map((v, c) => v - bg.data[offset + c]), norm = delta.reduce((s, v) => s + v * v, 0);
            const coverage = norm ? delta.reduce((s, v, c) => s + v * (fg.data[offset + c] - bg.data[offset + c]), 0) / norm : 0;
            if (coverage < .5 || coverage > 1.05 || !rgb.every((v, c) => Math.abs(bg.data[offset + c] + delta[c] * coverage - fg.data[offset + c]) <= 6)) continue;
            const b = lum([...bg.data.slice(offset, offset + 3)]); samples++;
            worst = Math.min(worst, (Math.max(l, b) + .05) / (Math.min(l, b) + .05));
          }
        }
        results.push({ text: text.textContent, size: parseFloat(getComputedStyle(text).fontSize), ratio: +worst.toFixed(3), samples });
      }
      return results;
    }, { ink: ink.toString('base64'), underlay: underlay.toString('base64'), scale });
  };

  // Pixels outside the card's rounded edge (8 px around it) are the screen's, as at HEAD.
  const surroundings = async page => {
    const clip = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="ranking-my-card"]').getBoundingClientRect();
      return { x: card.left - 8, y: Math.max(0, card.top - 8), width: card.width + 16, height: card.height + 16, card: { x: card.left, y: card.top, width: card.width, height: card.height },
        radius: parseFloat(getComputedStyle(document.querySelector('[data-testid="ranking-my-card"]')).borderTopLeftRadius) };
    });
    const shot = await page.screenshot({ clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height } });
    return { clip, shot };
  };
  const differsOutside = (page, a, b, clip, scale) => page.evaluate(async ({ a, b, clip, scale }) => {
    const pixels = async source => {
      const im = new Image(); im.src = `data:image/png;base64,${source}`; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0); return ctx.getImageData(0, 0, c.width, c.height);
    };
    const A = await pixels(a), B = await pixels(b); let differing = 0, checked = 0;
    const { card, radius } = clip;
    // Outside the rounded rectangle by more than 1.5 px: the card's own antialiased edge (whose
    // compositing may differ once layers inside it move) is not light leaking out.
    const outside = (x, y) => {
      const px = clip.x + x / scale, py = clip.y + y / scale;
      const cx = Math.min(Math.max(px, card.x + radius), card.x + card.width - radius), cy = Math.min(Math.max(py, card.y + radius), card.y + card.height - radius);
      return Math.hypot(px - cx, py - cy) > radius + 1.5;
    };
    for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
      if (!outside(x, y)) continue;
      const i = (y * A.width + x) * 4; checked++;
      if (Math.max(...[0, 1, 2].map(c => Math.abs(A.data[i + c] - B.data[i + c]))) > 2) differing++;
    }
    return { differing, checked };
  }, { a: a.toString('base64'), b: b.toString('base64'), clip, scale });

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  try {
    // 1) Layouts against HEAD, at a frozen moment 3 s into the spotlight.
    for (const tier of TIERS) for (const mode of MODES) for (const width of WIDTHS) for (const fontScale of SCALES) {
      const info = { tier, mode, width, fontScale };
      const head = await open({ bundle: 'baseline', tier, mode, width, fontScale, scale: 1, focused: true });
      const before = await inspect(head.page), beforeContrast = await contrast(head.page, 1), beforeAround = await surroundings(head.page);
      await head.close();
      const now = await open({ tier, mode, width, fontScale, scale: 1 });
      await now.focus(); await now.run(STEADY);
      const after = await inspect(now.page), afterContrast = await contrast(now.page, 1), afterAround = await surroundings(now.page);
      const outside = await differsOutside(now.page, beforeAround.shot, afterAround.shot, afterAround.clip, 1);
      const layers = await now.page.evaluate(() => ({ particles: document.querySelectorAll('[data-testid="tier-stage-particle"]').length,
        stage: document.querySelectorAll('[data-testid="tier-stage"]').length, ring: document.querySelectorAll('[data-testid="tier-stage-ring"]').length }));
      await now.close();
      if (!same(before.card, after.card)) fail(info, `card ${before.card} → ${after.card}`);
      for (const key of Object.keys(before.boxes)) if (!same(before.boxes[key], after.boxes[key])) fail(info, `${key} ${before.boxes[key]} → ${after.boxes[key]}`);
      if (!same(before.texts, after.texts)) fail(info, 'a text moved or changed');
      if (after.overflow) fail(info, 'sideways scroll');
      if (after.clip.overflow !== 'hidden' || !(parseFloat(after.clip.radius) > 0)) fail(info, `the card no longer clips (${JSON.stringify(after.clip)})`);
      if (outside.differing) fail(info, `${outside.differing}/${outside.checked} pixels changed outside the card`);
      if (layers.stage !== 1 || layers.particles !== 9 || layers.ring !== 0) fail(info, `layers ${JSON.stringify(layers)}`);
      const pairs = afterContrast.map(c => ({ ...c, head: beforeContrast.find(h => h.text === c.text)?.ratio }));
      for (const c of pairs) {
        const floor = c.size >= 24 ? 3 : 4.5;
        if (!(c.samples > 0)) fail(info, `no contrast samples for ${c.text}`);
        else if (c.ratio < floor && !(c.head < floor && c.ratio >= c.head - 0.05)) fail(info, `${c.text} ${c.ratio}:1 (HEAD ${c.head})`);
      }
      records.layouts.push({ ...info, card: after.card, slot: after.boxes.slot, caption: after.boxes.caption, contrast: pairs, outside });
      console.log(`layout ${tier} ${mode} ${width} ×${fontScale}: card ${after.card.join('×')}, worst ${Math.min(...pairs.map(c => c.ratio)).toFixed(2)} (HEAD ${Math.min(...pairs.map(c => c.head)).toFixed(2)})`);
    }

    // 2) Screenshots for review: every tier and mode at both widths and text sizes, 3 s in.
    for (const tier of TIERS) for (const mode of MODES) for (const width of WIDTHS) for (const fontScale of SCALES) {
      const now = await open({ tier, mode, width, fontScale });
      await now.focus(); await now.run(STEADY);
      await now.page.getByTestId('ranking-my-card').screenshot({ path: path.join(out, `steady-${name(tier)}-${mode}-${width}-${fontScale}x.png`) });
      await now.close();
    }

    // 3) Reduced motion: a still beam and floor glow, no entrance, nothing changes with time.
    for (const tier of TIERS) for (const mode of MODES) {
      const info = { tier, mode, reduced: true };
      const still = await open({ tier, mode, reduced: true });
      await still.focus();
      const first = await still.page.getByTestId('ranking-my-card').screenshot();
      const state = await still.page.evaluate(() => {
        const q = id => document.querySelectorAll(`[data-testid="${id}"]`).length;
        const beam = document.querySelector('[data-testid="tier-stage-beam"]'), emblem = document.querySelector('[data-testid^="home-emblem-"]');
        return { particles: q('tier-stage-particle'), ring: q('tier-stage-ring'), flash: q('tier-stage-flash'),
          beam: q('tier-stage-beam'), floor: q('tier-stage-floor'), beamTransform: getComputedStyle(beam).transform,
          emblemTransform: getComputedStyle(emblem).transform, emblemOpacity: getComputedStyle(emblem).opacity };
      });
      await still.run(2500);
      const later = await still.page.getByTestId('ranking-my-card').screenshot();
      fs.writeFileSync(path.join(out, `reduced-${name(tier)}-${mode}.png`), later);
      await still.close();
      const identity = transform => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(transform);
      if (state.particles + state.ring + state.flash !== 0 || state.beam !== 1 || state.floor !== 1) fail(info, `layers ${JSON.stringify(state)}`);
      if (!identity(state.beamTransform) || !identity(state.emblemTransform) || state.emblemOpacity !== '1') fail(info, `not still ${JSON.stringify(state)}`);
      if (!first.equals(later)) fail(info, 'the card changed over 2.5 s');
      records.reduced.push({ ...info, ...state, unchanged: first.equals(later) });
    }

    // 4) The entrance at the mock-up's frame times (390, 1×), with the emblem's pose.
    for (const tier of TIERS) for (const mode of MODES) {
      const now = await open({ tier, mode });
      await now.focus();
      let time = 0;
      const frames = [];
      for (const at of FRAMES) {
        await now.run(at - time); time = at;
        const shot = await now.page.getByTestId('ranking-my-card').screenshot();
        fs.writeFileSync(path.join(out, `entrance-${name(tier)}-${mode}-${at}.png`), shot);
        const pose = await now.page.evaluate(() => {
          const emblem = document.querySelector('[data-testid^="home-emblem-"]');
          const m = new DOMMatrix(getComputedStyle(emblem).transform);
          return { y: +m.m42.toFixed(2), scale: +Math.hypot(m.m11, m.m12).toFixed(4), opacity: +getComputedStyle(emblem).opacity,
            ring: !!document.querySelector('[data-testid="tier-stage-ring"]'), flash: !!document.querySelector('[data-testid="tier-stage-flash"]') };
        });
        frames.push({ at, ...pose });
      }
      // The JS driver draws on 16 ms frames: the pose is the curve's somewhere in the last frame.
      const k = 124 / 132, { drop } = stage.stageMotion(124);
      const dropY = ms => {
        const index = 3 * stage.dropEasing(Math.min(1, Math.max(0, ms) / stage.STAGE_TIMING.drop));
        const segment = Math.min(2, Math.floor(index));
        return drop.y[segment] + (drop.y[segment + 1] - drop.y[segment]) * (index - segment);
      };
      for (const frame of frames) {
        const bob = ['platinum', 'diamond', 'master'].includes(tier) ? 6 * k : 0;
        const range = [dropY(frame.at - 17), dropY(frame.at)].sort((a, b) => a - b);
        if (frame.y < range[0] - 0.6 - bob || frame.y > range[1] + 0.6 + bob) fail({ tier, mode, at: frame.at }, `drop y ${frame.y} outside ${range.map(v => v.toFixed(2))}`);
      }
      // The ring ends at 0.38 + 0.9 s; then the flash and the ring are gone and the drop is at rest.
      await now.run(1300 - time);
      const rest = await now.page.evaluate(() => {
        const emblem = document.querySelector('[data-testid^="home-emblem-"]'), m = new DOMMatrix(getComputedStyle(emblem).transform);
        return { opacity: +getComputedStyle(emblem).opacity, scale: +Math.hypot(m.m11, m.m12).toFixed(4),
          ring: !!document.querySelector('[data-testid="tier-stage-ring"]'), flash: !!document.querySelector('[data-testid="tier-stage-flash"]') };
      });
      if (rest.opacity !== 1 || rest.ring || rest.flash || Math.abs(rest.scale - 1) > 0.001) fail({ tier, mode }, `not at rest after 1.3 s ${JSON.stringify(rest)}`);
      await now.close();
      records.entrance.push({ tier, mode, frames, rest });
    }

    // 5) No replay: refocus, Light/Dark and a remount (a new page is a new process: it plays).
    {
      const now = await open({ tier: 'gold', mode: 'light' });
      await now.focus(); await now.run(2000);
      const rest = () => now.page.evaluate(() => {
        const emblem = document.querySelector('[data-testid^="home-emblem-"]');
        return { opacity: getComputedStyle(emblem).opacity, y: new DOMMatrix(getComputedStyle(emblem).transform).m42, ring: !!document.querySelector('[data-testid="tier-stage-ring"]') };
      });
      const steps = [];
      await now.focus(false); await now.run(500); await now.focus(true); await now.run(100); steps.push(['refocus', await rest()]);
      await now.page.evaluate(() => window.fixture.appearance('dark')); await now.settle(); await now.run(100); steps.push(['dark', await rest()]);
      await now.page.evaluate(() => window.fixture.appearance('light')); await now.settle(); await now.run(100); steps.push(['light', await rest()]);
      await now.close();
      for (const [step, pose] of steps) if (pose.opacity !== '1' || Math.abs(pose.y) > 0.01 || pose.ring) fail({ flow: step }, `replayed ${JSON.stringify(pose)}`);
      records.flows.push(...steps.map(([step, pose]) => ({ step, ...pose })));
    }

    // 6) Side-by-side sheets with the mock-up (optional input).
    if (reference) await sheets();
  } finally {
    await browser.close(); server.close();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ failures, errors, records }, null, 1));
  }
  if (errors.length) failures.push({ message: `page errors: ${errors.slice(0, 3).join(' | ')}` });
  if (failures.length) { console.error(JSON.stringify(failures.slice(0, 20), null, 1)); process.exit(1); }
  console.log(`PASS: ${records.layouts.length} layouts vs HEAD, ${records.reduced.length} reduced-motion cards, ${records.entrance.length} entrances, ${records.flows.length} replay steps`);

  // The mock-up crops (358-wide card at DPR 2, its left 30% cut) next to the same crop of ours,
  // and the same 360 px square around each emblem so the light can be compared in place.
  async function sheets() {
    const page = await browser.newPage();
    const png = file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    const cells = { light: [34, 520], dark: [1006, 1492] };
    // Emblem centers in the mock-up (template-matched, device px from each cell's left/top).
    const steadyRef = png(path.join(reference, 'REF-steady-6tiers-light-dark.png'));
    const entranceRef = png(path.join(reference, 'REF-entrance-gold-light.png'));
    const entries = [];
    for (const [index, tier] of TIERS.entries()) for (const mode of MODES) {
      entries.push({ label: `${name(tier)} · ${mode}`, ref: { x: [8, 518, 1028][index % 3], y: cells[mode][index < 3 ? 0 : 1] },
        mine: png(path.join(out, `steady-${name(tier)}-${mode}-390-1x.png`)) });
    }
    const steady = await page.evaluate(async ({ steadyRef, entries }) => {
      const load = async src => { const im = new Image(); im.src = src; await im.decode(); return im; };
      const ref = await load(steadyRef);
      const c = document.createElement('canvas'); c.width = 1040; c.height = entries.length * 500 + 20;
      const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.font = 'bold 18px sans-serif';
      for (const [i, entry] of entries.entries()) {
        const mine = await load(entry.mine), y = 20 + i * 500;
        g.fillStyle = '#111'; g.fillText(`${entry.label}: mock-up | app (3 s, 390 dp, E 124)`, 10, y + 4);
        g.drawImage(ref, entry.ref.x, entry.ref.y, 501, 460, 10, y + 14, 501, 460);
        g.drawImage(mine, Math.round(mine.width * 0.3), 0, mine.width - Math.round(mine.width * 0.3), Math.min(mine.height, 480), 525, y + 14,
          mine.width - Math.round(mine.width * 0.3), Math.min(mine.height, 480));
      }
      return c.toDataURL('image/png').split(',')[1];
    }, { steadyRef, entries });
    fs.writeFileSync(path.join(out, 'sheet-steady.png'), Buffer.from(steady, 'base64'));
    const frames = FRAMES.map(at => ({ at, mine: png(path.join(out, `entrance-gold-light-${at}.png`)) }));
    const entrance = await page.evaluate(async ({ entranceRef, frames }) => {
      const load = async src => { const im = new Image(); im.src = src; await im.decode(); return im; };
      const ref = await load(entranceRef), spots = [[8, 34], [518, 34], [1028, 34], [1538, 34], [8, 520], [518, 520], [1028, 520]];
      const c = document.createElement('canvas'); c.width = 1040; c.height = frames.length * 480 + 20;
      const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.font = 'bold 18px sans-serif';
      for (const [i, frame] of frames.entries()) {
        const mine = await load(frame.mine), y = 20 + i * 480, cut = Math.round(mine.width * 0.3);
        g.fillStyle = '#111'; g.fillText(`Gold light t=${frame.at}ms: mock-up | app`, 10, y + 4);
        g.drawImage(ref, spots[i][0], spots[i][1], 501, 440, 10, y + 14, 501, 440);
        g.drawImage(mine, cut, 0, mine.width - cut, Math.min(mine.height, 460), 525, y + 14, mine.width - cut, Math.min(mine.height, 460));
      }
      return c.toDataURL('image/png').split(',')[1];
    }, { entranceRef, frames });
    fs.writeFileSync(path.join(out, 'sheet-entrance-gold-light.png'), Buffer.from(entrance, 'base64'));
    await page.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
