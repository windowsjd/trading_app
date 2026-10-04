// Production components and RN Web. All requests remain on the local fixture server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.BRAND_GRADIENT_AUDIT_OUTPUT ?? '/tmp/trading-brand-gradient-audit';
const expectedColors = ['#326FE5', '#7447D8'];
const start = [50, 111, 229], end = [116, 71, 216];

async function run() {
  fs.mkdirSync(out, { recursive: true });
  const bundle = path.join(out, 'fixture.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'brandGradientAuditFixture.jsx')], outfile: bundle,
    bundle: true, minify: true, platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'], mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    plugins: [{ name: 'native-web', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/fixture.js' ? fs.readFileSync(bundle)
      : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/fixture.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  const errors = [], records = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('trading-app:appearance', 'system'));
    const id = (name) => page.getByTestId(name);
    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430, 1024]) for (const fontScale of [1, 2]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: appearance });
      await page.goto(`${base}/?fontScale=${fontScale}`);
      await id('brand-full').waitFor();
      const gradients = [];
      for (const name of ['brand-full', 'brand-narrow', 'brand-custom', 'brand-lesson']) {
        const button = id(name);
        const metrics = await button.evaluate((el) => {
          const box = (node) => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          };
          const svg = el.querySelector('svg'), gradient = svg.querySelector('linearGradient');
          const css = getComputedStyle(el);
          const label = el.querySelector('[dir="auto"]');
          return { button: box(el), svg: box(svg), id: gradient.id,
            units: gradient.getAttribute('gradientUnits'),
            coords: ['x1', 'y1', 'x2', 'y2'].map((key) => gradient.getAttribute(key)),
            stops: [...gradient.querySelectorAll('stop')].map((stop) => ({
              color: stop.getAttribute('stop-color'), offset: stop.getAttribute('offset'), opacity: stop.getAttribute('stop-opacity'),
            })),
            rect: svg.querySelector('rect').getAttribute('fill'),
            foreground: getComputedStyle(label).color, radius: css.borderRadius,
            transform: css.transform, shadow: css.boxShadow, border: css.borderWidth,
          };
        });
        assert.equal(metrics.units, 'objectBoundingBox');
        assert.deepEqual(metrics.coords, ['0%', '50%', '100%', '50%']);
        assert.deepEqual(metrics.stops.map((stop) => stop.color.toUpperCase()), expectedColors);
        assert.deepEqual(metrics.stops.map((stop) => Number.parseFloat(stop.offset) / (stop.offset.endsWith('%') ? 100 : 1)), [0, 1]);
        assert.deepEqual(metrics.stops.map((stop) => Number(stop.opacity)), [1, 1]);
        assert.equal(metrics.rect, `url(#${metrics.id})`);
        assert.equal(metrics.foreground, 'rgb(255, 255, 255)');
        assert.equal(metrics.transform, 'none'); assert.equal(metrics.shadow, 'none');
        const inset = name === 'brand-lesson' ? 2 : 0;
        assert.ok(Math.abs(metrics.svg.width + inset - metrics.button.width) < 1, 'gradient fills this button width');
        assert.ok(Math.abs(metrics.svg.height + inset - metrics.button.height) < 1, 'gradient fills this button height');
        const shot = await button.screenshot();
        const pixels = await page.evaluate(async (data) => {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          await img.decode();
          const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
          return [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1].map((fraction) => {
            const x = Math.min(img.width - 1, Math.floor(fraction * img.width));
            const y = fraction === 0 || fraction === 1 ? Math.floor(img.height / 2) : 10;
            return { x, y, width: img.width, fraction, rgb: [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3) };
          });
        }, shot.toString('base64'));
        // LessonAction retains its existing one-pixel information border.
        for (const pixel of pixels.filter((pixel) => name !== 'brand-lesson' || pixel.fraction > 0 && pixel.fraction < 1)) {
          const t = (pixel.x + 0.5) / pixel.width;
          for (let channel = 0; channel < 3; channel++) {
            const expected = start[channel] + (end[channel] - start[channel]) * t;
            assert.ok(Math.abs(pixel.rgb[channel] - expected) <= 2, `${name} ${appearance} ${width}: pixel at ${pixel.fraction} is ${pixel.rgb}, expected linear interpolation`);
          }
        }
        gradients.push({ name, metrics, pixels });
      }
      assert.equal(new Set(gradients.map((item) => item.metrics.id)).size, gradients.length, 'sibling buttons have independent gradient IDs');
      const full = await id('brand-full').boundingBox(), neutral = await id('brand-neutral').boundingBox();
      assert.equal(full.width, neutral.width); assert.equal(full.height, neutral.height, 'decoration does not change layout');
      assert.equal((await id('brand-narrow').boundingBox()).width, 96, 'narrow buttons keep their existing width');
      for (const name of ['brand-neutral', 'brand-disabled', 'brand-blocked', 'brand-loading', 'brand-buy', 'brand-sell', 'brand-selected', 'brand-lesson-choice', 'brand-lesson-financial', 'brand-lesson-secondary']) {
        assert.equal(await id(name).locator('linearGradient').count(), 0, `${name} preserves its original role/state`);
      }
      const selected = await id('brand-selected').evaluate((el) => getComputedStyle(el).backgroundColor);
      assert.equal(selected, appearance === 'light' ? 'rgb(32, 42, 53)' : 'rgb(52, 70, 87)');
      assert.equal(await id('brand-disabled').evaluate((el) => getComputedStyle(el).opacity), '0.45');
      assert.equal(await id('brand-blocked').getAttribute('aria-disabled'), 'true');
      assert.equal(await id('brand-loading').getAttribute('aria-disabled'), 'true');
      assert.equal(await id('brand-loading').getByRole('progressbar').count(), 1, 'loading keeps its existing indicator');
      await id('brand-full').scrollIntoViewIfNeeded();
      const restingBox = await id('brand-full').boundingBox();
      await page.mouse.move(restingBox.x + restingBox.width / 2, restingBox.y + restingBox.height / 2);
      await page.mouse.down();
      await page.waitForFunction(() => [...document.querySelector('[data-testid="brand-full"]').children]
        .some((child) => Number(getComputedStyle(child).opacity) > 0 && Number(getComputedStyle(child).opacity) < 1), undefined, { timeout: 5000 });
      const wash = await id('brand-full').evaluate((el) => [...el.children].some((child) => Number(getComputedStyle(child).opacity) > 0 && Number(getComputedStyle(child).opacity) < 1));
      assert.ok(wash, 'the existing pressed wash remains above the gradient');
      assert.deepEqual(await id('brand-full').boundingBox(), restingBox, 'pressing preserves geometry');
      await page.mouse.up();
      assert.equal(await page.evaluate(() => window.actionCalls), 1, 'one tap invokes the original callback once');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      if (width === 390 && fontScale === 1) {
        await page.screenshot({ path: path.join(out, `${appearance}.png`), fullPage: true });
      }
      records.push({ appearance, width, fontScale, gradients });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ records, errors }, null, 2));
    console.log(`BRAND_GRADIENT_AUDIT_PASSED ${records.length} layouts: pixels, geometry, protected roles, states and immediate actions`);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
