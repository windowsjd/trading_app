// 내 순위 spotlight anchor (2026-10-16 follow-up). Every light layer is placed from one anchor, the
// emblem as it is seen; this check measures that on the rendered page (the actual RankingScreen over
// the ranking fixtures, Playwright's fake clock):
// - the emblem: the `home-tier-image` box at rest (its drop and float lifted while measuring) and the
//   silhouette's alpha bounds read from the PNG itself (alpha > 8; preparation.json must agree);
// - the beam: its untransformed box, computed transform and transform-origin give the drawn center
//   line, at sway −3.5°, 0° and +3.5° (as the loop starts, 3.5 s and 7 s after focus);
// - the floor glow, the landing ring (during the entrance) and the particles at rest.
// Pass: the center line within 1 px of the emblem's center at every angle, the glow's center within
// 1 px of (cx, visible bottom − 8k), the ring on the glow, every particle at its offset, the layers
// hidden from screen readers. A pixel check at 0° compares the lit span's middle in the card's top
// rows (the beam alone vs the light hidden) with the emblem's center. Layout histories (a resize
// after the first layout, a profile that arrives late) must end on the same anchor: RN-Web reports a
// view's x/y only when its size changes, which is how the light came to stand beside the emblem.
//
// SPOTLIGHT_ANCHOR_SOURCE (a directory holding `src/`) builds another tree instead, e.g. a HEAD copy.
// SPOTLIGHT_ANCHOR_DEBUG (a directory) gets crosshair sheets: Gold, Diamond and Whale × Light/Dark,
// and Gold Light after a 360 → 390 resize. SPOTLIGHT_ANCHOR_QUICK=1 runs 390 × 1 only;
// SPOTLIGHT_ANCHOR_TIERS=gold,master limits the tiers (and the histories) to those.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.SPOTLIGHT_ANCHOR_OUTPUT ?? '/tmp/trading-ranking-spotlight-anchor';
const source = process.env.SPOTLIGHT_ANCHOR_SOURCE;
const debug = process.env.SPOTLIGHT_ANCHOR_DEBUG;
const quick = process.env.SPOTLIGHT_ANCHOR_QUICK === '1';
const only = process.env.SPOTLIGHT_ANCHOR_TIERS?.split(',');
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'master'].filter(tier => !only || only.includes(tier));
const MODES = ['light', 'dark'];
const WIDTHS = quick ? [390] : [320, 390];
const SCALES = quick ? [1] : [1, 2];
// Milliseconds after focus → the sway's angle: −3.5° as it starts, 0° a quarter cycle in, +3.5° at half.
// Crosshair sheets take −3.5° a whole cycle later, with the emblem landed (it is still hidden as the loop starts).
const ANGLES = [[16, -3.5], [3500, 0], [7000, 3.5]];
const SHEET_ANGLES = [[3500, 0], [7000, 3.5], [14000, -3.5]];
const HISTORIES = [
  { label: '360→390', from: 360, to: 390 }, { label: '390→360', from: 390, to: 360 },
  { label: '320→390', from: 320, to: 390 }, { label: '390→320', from: 390, to: 320 },
  { label: 'late profile at 320', from: 320, late: true },
];
const DEBUG_TIERS = ['gold', 'diamond', 'master'].filter(tier => !only || only.includes(tier));
const TOLERANCE = 1;
const name = tier => (tier === 'master' ? 'whale' : tier);
const stage = require(path.join(root, 'src/screens/home/tierStage.ts'));
const preparation = require(path.join(root, 'src/assets/home-tiers/preparation.json'));
// RankingScreen's emblem: 104 under 360 dp, else 124.
const kAt = width => (width < 360 ? 104 : 124) / stage.STAGE_EMBLEM;

async function build(outfile) {
  await esbuild.build({ entryPoints: [path.join(__dirname, 'rankingSpotlightFixture.jsx')], outfile,
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' }, loader: { '.png': 'dataurl' },
    plugins: [{ name: 'ranking-spotlight-anchor', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks)$/ }, () => ({ path: path.join(__dirname, 'rankingTierMocks.js') }));
      if (source) b.onResolve({ filter: /^\.\.\/\.\.\/src\// }, args => {
        const file = path.resolve(path.dirname(args.importer), args.path).replace(path.join(root, 'src'), path.join(source, 'src'));
        return { path: ['.tsx', '.ts', '.jsx', '.js'].map(ext => file + ext).find(fs.existsSync) };
      });
    } }], logLevel: 'warning' });
}

// Everything in card px, measured with the layers' own transforms except the beam's swing.
const measure = (page, k) => page.evaluate(({ k }) => {
  const card = document.querySelector('[data-testid="ranking-my-card"]'), c = card.getBoundingClientRect();
  const rel = r => ({ left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height });
  const still = (el, read) => { const saved = el.style.transform; el.style.transform = 'none'; try { return read(); } finally { el.style.transform = saved; } };
  const emblem = card.querySelector('[data-testid^="home-emblem-"]'), picture = card.querySelector('[data-testid="home-tier-image"]');
  const image = still(emblem, () => rel(picture.getBoundingClientRect()));
  const { bounds: [l, t, r, b], size: [w, h] } = window.silhouette;
  const seen = { cx: image.left + (l + r) / 2 / w * image.width, cy: image.top + (t + b) / 2 / h * image.height, bottom: image.top + b / h * image.height };
  // The beam's drawn center line: its box's middle through the computed transform about its origin.
  const beam = card.querySelector('[data-testid="tier-stage-beam"]'), box = still(beam, () => rel(beam.getBoundingClientRect()));
  const style = getComputedStyle(beam), m = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
  const [ox, oy] = style.transformOrigin.split(' ').map(parseFloat);
  const map = (x, y) => { const p = m.transformPoint(new DOMPoint(x - ox, y - oy)); return { x: box.left + ox + p.x, y: box.top + oy + p.y }; };
  const top = map(box.width / 2, 0), end = map(box.width / 2, box.height), dx = end.x - top.x, dy = end.y - top.y;
  const floor = card.querySelector('[data-testid="tier-stage-floor"]'), glow = still(floor, () => rel(floor.getBoundingClientRect()));
  const ringNode = card.querySelector('[data-testid="tier-stage-ring"]'), ring = ringNode && still(ringNode, () => rel(ringNode.getBoundingClientRect()));
  const center = r => ({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, width: r.width, height: r.height });
  const layers = card.querySelector('[data-testid="tier-stage"]');
  return {
    card: [c.width, c.height], image, seen, beam: box, top, end,
    angle: Math.atan2(m.b, m.a) * 180 / Math.PI,
    // Distance from the emblem's center to the line, and where the line crosses the emblem's height.
    offAxis: Math.abs(dx * (seen.cy - top.y) - dy * (seen.cx - top.x)) / Math.hypot(dx, dy),
    axisShift: top.x + dx * (seen.cy - top.y) / dy - seen.cx,
    glow: center(glow), ring: ring && center(ring),
    particles: [...card.querySelectorAll('[data-testid="tier-stage-particle"]')].map(el => center(still(el, () => rel(el.getBoundingClientRect()))))
      .map(p => ({ x: (p.cx - seen.cx) / k, y: (p.cy - seen.cy) / k })),
    hidden: layers.getAttribute('aria-hidden') === 'true' && !layers.querySelector('[tabindex], a, button, input'),
  };
}, { k });

// The beam's lit span in the card's top rows at 0°: the beam alone against the same frame with no light.
async function litTop(page, scale) {
  const card = page.getByTestId('ranking-my-card');
  const only = await page.addStyleTag({ content: ['floor', 'particle', 'ring', 'flash'].map(id => `[data-testid="tier-stage-${id}"]`).join(',') + '{visibility:hidden!important}' });
  const lit = await card.screenshot(); await only.evaluate(node => node.remove());
  const none = await page.addStyleTag({ content: '[data-testid="tier-stage"]{visibility:hidden!important}' });
  const bare = await card.screenshot(); await none.evaluate(node => node.remove());
  return page.evaluate(async ({ lit, bare, scale }) => {
    const pixels = async src => {
      const im = new Image(); im.src = `data:image/png;base64,${src}`; await im.decode();
      const canvas = document.createElement('canvas'); canvas.width = im.width; canvas.height = im.height;
      const g = canvas.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height);
    };
    const A = await pixels(lit), B = await pixels(bare), middles = [];
    for (let y = 2 * scale; y < 12 * scale; y++) {
      let first = -1, last = -1;
      for (let x = 0; x < A.width; x++) {
        const i = (y * A.width + x) * 4;
        if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 6) { if (first < 0) first = x; last = x; }
      }
      if (first >= 0) middles.push((first + last + 1) / 2 / scale);
    }
    return { rows: middles.length, middle: middles.reduce((sum, value) => sum + value, 0) / Math.max(1, middles.length) };
  }, { lit: lit.toString('base64'), bare: bare.toString('base64'), scale });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  if (debug) fs.mkdirSync(debug, { recursive: true });
  await build(path.join(out, 'anchor.js'));
  const server = http.createServer((req, res) => {
    if (new URL(req.url, 'http://fixture.invalid').pathname.endsWith('.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(out, 'anchor.js'))); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/anchor.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const failures = [], errors = [], records = { silhouettes: {}, layouts: [], reduced: [], histories: [] };
  const fail = (info, message) => failures.push({ ...info, message });
  const launch = () => chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-sandbox', '--renderer-process-limit=2'] });
  let browser = await launch(), opened = 0;

  // A page frozen right before the tab gains focus; `at(ms)` runs the clock to that long after focus.
  async function open({ tier, mode, width, fontScale = 1, reduced = false, scale = 2, late = false }) {
    if (++opened % 40 === 0) { await browser.close(); browser = await launch(); }
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: scale, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${tier} ${mode} ${width}: ${e.message}`));
    await page.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    await page.addInitScript(mode => { localStorage.setItem('trading-app:appearance', mode); localStorage.setItem('trading-app:financial-colors', 'red_blue'); }, mode);
    await page.clock.install({ time: new Date('2026-10-16T00:00:00Z') });
    await page.goto(`${base}/?tier=${tier}&fontScale=${fontScale}&myReturn=4.5&myTotal=10450000&focused=0${late ? '&meDelay=6000' : ''}`);
    await page.getByTestId('ranking-return-row-3').waitFor();
    await page.getByTestId('tier-stage-floor').waitFor({ state: 'attached' });
    // The silhouette's alpha bounds from the emblem PNG itself (checked against preparation.json once per tier).
    await page.evaluate(async () => {
      const im = new Image(); im.src = document.querySelector('[data-testid="home-tier-image"] img').src; await im.decode();
      const canvas = document.createElement('canvas'); canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
      const g = canvas.getContext('2d'); g.drawImage(im, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, canvas.width, canvas.height);
      let left = width, top = height, right = 0, bottom = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) { left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1); }
      }
      window.silhouette = { bounds: [left, top, right, bottom], size: [width, height] };
      await document.fonts.ready;
    });
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 500);
    await page.waitForTimeout(80);
    let time = 0;
    const settle = () => page.waitForTimeout(60);
    return { page,
      silhouette: () => page.evaluate(() => window.silhouette),
      focus: async () => { await page.evaluate(() => window.fixture.focus(true)); await settle(); },
      at: async ms => { await page.clock.runFor(ms - time); time = ms; await settle(); },
      close: () => context.close() };
  }

  // The anchor's rules on one measurement; `angle` (when given) is the sway the frame must show.
  function judge(info, m, k, angle) {
    if (angle !== undefined && Math.abs(m.angle - angle) > 0.05) fail(info, `sway ${m.angle.toFixed(3)}° (expected ${angle}°)`);
    if (!(m.offAxis <= TOLERANCE)) fail(info, `beam center line ${m.offAxis.toFixed(2)} px from the emblem's center (at its height ${m.axisShift.toFixed(2)})`);
    const floorY = m.seen.bottom - 8 * k;
    if (!(Math.abs(m.glow.cx - m.seen.cx) <= TOLERANCE)) fail(info, `glow x ${m.glow.cx.toFixed(2)} vs emblem ${m.seen.cx.toFixed(2)}`);
    if (!(Math.abs(m.glow.cy - floorY) <= TOLERANCE)) fail(info, `glow y ${m.glow.cy.toFixed(2)} vs visible bottom − 8k ${floorY.toFixed(2)}`);
    if (Math.abs(m.glow.width - 180 * k) > 0.5 || Math.abs(m.glow.height - 26 * k) > 0.5) fail(info, `glow ${m.glow.width}×${m.glow.height}`);
    if (m.ring && (Math.hypot(m.ring.cx - m.glow.cx, m.ring.cy - m.glow.cy) > 0.5 || Math.abs(m.ring.width - m.glow.width) > 0.5 || Math.abs(m.ring.height - m.glow.height) > 0.5)) fail(info, 'the ring is not the glow\'s ellipse');
    if (m.particles.length && m.particles.length !== stage.PARTICLES.length) fail(info, `${m.particles.length} particles`);
    m.particles.forEach((p, index) => {
      const spec = stage.PARTICLES[index];
      if (Math.abs(p.x - spec.x) * k > TOLERANCE || Math.abs(p.y - spec.y) * k > TOLERANCE) fail(info, `particle ${index + 1} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) / k, not (${spec.x}, ${spec.y})`);
    });
    if (!m.hidden) fail(info, 'the light is exposed to screen readers');
  }

  // Crosshair sheet: the emblem's center (magenta), the beam's center line (cyan), the glow's center (yellow).
  async function drawSheet(page, panels, file) {
    const data = await page.evaluate(async ({ panels }) => {
      const load = async src => { const im = new Image(); im.src = `data:image/png;base64,${src}`; await im.decode(); return im; };
      const images = await Promise.all(panels.map(panel => load(panel.shot)));
      const scale = 2, gap = 24, head = 30, width = images.reduce((sum, im) => sum + im.width, 0) + gap * (images.length + 1);
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = Math.max(...images.map(im => im.height)) + head + gap;
      const g = canvas.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
      let x0 = gap;
      panels.forEach((panel, index) => {
        const im = images[index], m = panel.m, at = (x, y) => [x0 + x * scale, head + y * scale];
        g.drawImage(im, x0, head);
        g.save(); g.beginPath(); g.rect(x0, head, im.width, im.height); g.clip();
        const line = (from, to, color, width = 2, dash = []) => { g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.beginPath(); g.moveTo(...at(...from)); g.lineTo(...at(...to)); g.stroke(); };
        // The beam's center line, run past the card both ways.
        const dx = m.end.x - m.top.x, dy = m.end.y - m.top.y, far = 4;
        line([m.top.x - dx * far, m.top.y - dy * far], [m.top.x + dx * far, m.top.y + dy * far], 'rgba(0, 0, 0, 0.55)', 5);
        line([m.top.x - dx * far, m.top.y - dy * far], [m.top.x + dx * far, m.top.y + dy * far], '#00e5ff', 2);
        // The glow: its center and its vertical axis up through the emblem.
        line([m.glow.cx, m.glow.cy], [m.glow.cx, m.seen.cy - 40], 'rgba(0, 0, 0, 0.55)', 5, [8, 6]);
        line([m.glow.cx, m.glow.cy], [m.glow.cx, m.seen.cy - 40], '#ffd400', 2, [8, 6]);
        line([m.glow.cx - 16, m.glow.cy], [m.glow.cx + 16, m.glow.cy], '#ffd400', 3);
        // The emblem's center (the silhouette's alpha bounds on the rendered image).
        for (const [a, b] of [[[m.seen.cx - 22, m.seen.cy], [m.seen.cx + 22, m.seen.cy]], [[m.seen.cx, m.seen.cy - 22], [m.seen.cx, m.seen.cy + 22]]]) {
          line(a, b, 'rgba(0, 0, 0, 0.6)', 5); line(a, b, '#ff2bd6', 2);
        }
        g.restore();
        g.fillStyle = '#111111'; g.font = 'bold 15px sans-serif';
        g.fillText(`${panel.label}: line ${m.offAxis.toFixed(2)} px off, glow Δx ${(m.glow.cx - m.seen.cx).toFixed(2)} Δy ${(m.glow.cy - panel.floorY).toFixed(2)}`, x0, 20);
        x0 += im.width + gap;
      });
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    }, { panels: panels.map(panel => ({ ...panel, shot: panel.shot.toString('base64') })) });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  try {
    // 1) Every layout at 0°, +3.5° and −3.5°; the ring during the entrance; the lit top at 0°.
    for (const tier of TIERS) for (const mode of MODES) for (const width of WIDTHS) for (const fontScale of SCALES) {
      const info = { tier: name(tier), mode, width, fontScale }, k = kAt(width), scale = 2;
      const now = await open({ tier, mode, width, fontScale, scale });
      const silhouette = await now.silhouette();
      if (!records.silhouettes[name(tier)]) {
        records.silhouettes[name(tier)] = silhouette;
        const prepared = preparation[name(tier)];
        if (JSON.stringify(silhouette) !== JSON.stringify({ bounds: prepared.outputMetrics.bounds, size: prepared.outputSize })) {
          fail(info, `PNG alpha bounds ${JSON.stringify(silhouette)} ≠ preparation.json ${JSON.stringify(prepared.outputMetrics.bounds)}`);
        }
      }
      await now.focus();
      const sheet = debug && width === 390 && fontScale === 1 && DEBUG_TIERS.includes(tier);
      const frames = [];
      let entrance = null;
      for (const [ms, angle] of sheet ? SHEET_ANGLES : ANGLES) {
        if (ms > 600 && !entrance) {
          // The landing ring, 0.6 s into the entrance, on the glow's ellipse.
          await now.at(600);
          entrance = await measure(now.page, k);
          if (!entrance.ring) fail(info, 'no ring 0.6 s into the entrance');
          judge({ ...info, at: 'entrance' }, entrance, k);
        }
        await now.at(ms);
        const m = await measure(now.page, k);
        judge({ ...info, angle }, m, k, angle);
        if (angle === 0) {
          const lit = await litTop(now.page, scale);
          if (lit.rows < 10 || !(Math.abs(lit.middle - m.seen.cx) <= TOLERANCE)) fail({ ...info, angle }, `lit top's middle ${lit.middle.toFixed(2)} vs emblem ${m.seen.cx.toFixed(2)} (${lit.rows} rows)`);
          m.litTop = lit;
        }
        if (sheet) {
          frames.push({ label: `${name(tier)} ${mode} ${angle > 0 ? '+' : ''}${angle}°`, m, floorY: m.seen.bottom - 8 * k, shot: await now.page.getByTestId('ranking-my-card').screenshot() });
        }
        records.layouts.push({ ...info, angle, card: m.card, seen: m.seen, measuredAngle: +m.angle.toFixed(3), offAxis: +m.offAxis.toFixed(3),
          axisShift: +m.axisShift.toFixed(3), glow: { dx: +(m.glow.cx - m.seen.cx).toFixed(3), dy: +(m.glow.cy - (m.seen.bottom - 8 * k)).toFixed(3) },
          particles: +Math.max(...m.particles.map((p, i) => Math.hypot(p.x - stage.PARTICLES[i].x, p.y - stage.PARTICLES[i].y) * k)).toFixed(3),
          ...(m.litTop ? { litTop: +(m.litTop.middle - m.seen.cx).toFixed(3) } : {}) });
      }
      if (frames.length) await drawSheet(now.page, frames.sort((a, b) => a.m.angle - b.m.angle), path.join(debug, `anchor-${name(tier)}-${mode}.jpg`));
      await now.close();
      const last = records.layouts.slice(-3), level = last.find(r => r.angle === 0);
      console.log(`${name(tier)} ${mode} ${width} ×${fontScale}: line ${last.map(r => `${r.offAxis.toFixed(2)}@${r.angle}°`).join(' ')} px, glow Δ(${level.glow.dx}, ${level.glow.dy}), lit top ${level.litTop}`);
    }

    // 2) Reduced motion: the still beam (0°) and the glow on the same anchor.
    for (const tier of TIERS) for (const width of [320, 390]) {
      const info = { tier: name(tier), mode: 'light', width, reduced: true }, k = kAt(width);
      const now = await open({ tier, mode: 'light', width, reduced: true });
      await now.focus(); await now.at(1000);
      const m = await measure(now.page, k);
      judge(info, m, k, 0);
      records.reduced.push({ ...info, offAxis: +m.offAxis.toFixed(3), glow: { dx: +(m.glow.cx - m.seen.cx).toFixed(3), dy: +(m.glow.cy - (m.seen.bottom - 8 * k)).toFixed(3) } });
      await now.close();
    }

    // 3) Layout histories: the card moves the emblem column after the first layout without resizing it.
    for (const history of HISTORIES) for (const tier of DEBUG_TIERS) {
      const info = { tier: name(tier), history: history.label };
      const now = await open({ tier, mode: 'light', width: history.from, late: history.late });
      await now.focus(); await now.at(1500);
      const first = await measure(now.page, kAt(history.from));
      if (history.late) {
        if (await now.page.getByTestId('ranking-my-avatar').count()) fail(info, 'the profile was already there');
        await now.at(9000);
        if (!(await now.page.getByTestId('ranking-my-avatar').count())) fail(info, 'the profile never arrived');
      } else {
        await now.page.setViewportSize({ width: history.to, height: 1000 });
        await now.at(1800);
      }
      const width = history.to ?? history.from, k = kAt(width), m = await measure(now.page, k);
      judge(info, m, k);
      records.histories.push({ ...info, moved: { x: +(m.seen.cx - first.seen.cx).toFixed(2), y: +(m.seen.cy - first.seen.cy).toFixed(2) },
        offAxis: +m.offAxis.toFixed(3), axisShift: +m.axisShift.toFixed(3), glow: { dx: +(m.glow.cx - m.seen.cx).toFixed(3), dy: +(m.glow.cy - (m.seen.bottom - 8 * k)).toFixed(3) } });
      if (debug && tier === 'gold' && history.label === '360→390') {
        await drawSheet(now.page, [{ label: `gold light 360→390 (${m.angle.toFixed(1)}°)`, m, floorY: m.seen.bottom - 8 * k, shot: await now.page.getByTestId('ranking-my-card').screenshot() }],
          path.join(debug, 'anchor-gold-light-resized-360-390.jpg'));
      }
      console.log(`${info.tier} ${history.label}: emblem moved (${records.histories.at(-1).moved.x}, ${records.histories.at(-1).moved.y}), line ${m.offAxis.toFixed(2)} px, glow Δ(${records.histories.at(-1).glow.dx}, ${records.histories.at(-1).glow.dy})`);
      await now.close();
    }
  } finally {
    await browser.close(); server.close();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ failures, errors, records }, null, 1));
  }
  if (errors.length) failures.push({ message: `page errors: ${errors.slice(0, 3).join(' | ')}` });
  const worst = key => Math.max(...records.layouts.map(r => Math.abs(typeof key === 'function' ? key(r) : r[key])));
  console.log(`worst over ${records.layouts.length} frames: line ${worst('offAxis').toFixed(3)} px, glow x ${worst(r => r.glow.dx).toFixed(3)}, glow y ${worst(r => r.glow.dy).toFixed(3)}, particles ${worst('particles').toFixed(3)}, lit top ${Math.max(...records.layouts.filter(r => 'litTop' in r).map(r => Math.abs(r.litTop))).toFixed(3)}`);
  if (failures.length) { console.error(JSON.stringify(failures.slice(0, 25), null, 1)); console.error(`${failures.length} failures`); process.exit(1); }
  console.log(`PASS: ${records.layouts.length / ANGLES.length} layouts × 3 angles, ${records.reduced.length} reduced-motion cards, ${records.histories.length} layout histories`);
})().catch(error => { console.error(error); process.exit(1); });
