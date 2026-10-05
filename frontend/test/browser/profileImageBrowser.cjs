// Real Expo Web picker/manipulator, FormData, Settings, ProfileAvatar and query cache.
// Existing account/navigation fixtures; only local HTTP, no production storage.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const { load } = require('../ledgerTestHarness.cjs');
const root = path.resolve(__dirname, '../..'), backend = path.resolve(root, '../backend');
const { validateProfileImage } = load(path.join(backend, 'src/auth/profile-image.validation.ts'), {
  '@nestjs/common': require(path.join(backend, 'node_modules/@nestjs/common')),
});
const out = process.env.PROFILE_IMAGE_BROWSER_OUTPUT ?? '/tmp/profile-image-browser';

async function main() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'rootTabsFixture.jsx')], outfile: path.join(out, 'bundle.js'),
    bundle: true, minify: true, platform: 'browser', format: 'iife',
    nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'],
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    loader: { '.png': 'dataurl' },
    plugins: [{ name: 'fixture-boundaries', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      b.onResolve({ filter: /(services\/api\/client|navigationHooks|useMarketTickers)$/ }, () => ({ path: path.join(__dirname, 'profileImageMocks.js') }));
    } }], logLevel: 'warning',
  });
  let me = { id: 'home-user', nickname: '사진 테스트', email: 'fixture@example.test', role: 'user', status: 'active', portfolioPublic: true, createdAt: '2026-10-06T00:00:00Z', profileImageUrl: null };
  const objects = new Map(), uploads = [], layouts = [], failures = [];
  let failNext = false, nextMutationGate = null;
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/api/v1/me/profile-image' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const gate = nextMutationGate; nextMutationGate = null; if (gate) await gate;
      if (failNext) { failNext = false; return reply(503, { success: false, error: { code: 'PROFILE_IMAGE_UPLOAD_FAILED' } }); }
      const body = Buffer.concat(chunks), start = body.indexOf('\r\n\r\n') + 4;
      const boundary = /boundary=(.*)/.exec(req.headers['content-type'] ?? '')?.[1];
      const end = body.lastIndexOf(`\r\n--${boundary}`);
      const bytes = body.subarray(start, end);
      assert.match(body.subarray(0, start).toString(), /name="file"; filename="profile.jpg"/);
      assert.match(body.subarray(0, start).toString(), /Content-Type: image\/jpeg/);
      const safe = validateProfileImage({ buffer: bytes, size: bytes.length, mimetype: 'image/jpeg' });
      const key = `/profile-images/home-user/${randomUUID()}.jpg`;
      objects.set(key, safe); me = { ...me, profileImageUrl: `http://127.0.0.1:${server.address().port}${key}` };
      uploads.push({ size: bytes.length, key });
      fs.writeFileSync(path.join(out, `upload-${uploads.length}.jpg`), safe);
      return reply(200, { success: true, data: me });
    }
    if (req.url === '/api/v1/me/profile-image' && req.method === 'DELETE') {
      const gate = nextMutationGate; nextMutationGate = null; if (gate) await gate;
      me = { ...me, profileImageUrl: null }; return reply(200, { success: true, data: me });
    }
    if (req.url === '/api/v1/me') {
      if (req.method === 'PATCH') { const chunks = []; for await (const chunk of req) chunks.push(chunk); me = { ...me, ...JSON.parse(Buffer.concat(chunks).toString()) }; }
      return reply(200, { success: true, data: me });
    }
    if (objects.has(req.url)) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(objects.get(req.url)); }
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(out, 'bundle.js'))); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0;font-family:"Noto Sans CJK KR",sans-serif}</style><div id="root"></div><script src="/bundle.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage(); const base = `http://127.0.0.1:${server.address().port}`;
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => { failures.push(error.message); console.error('pageerror:', error.message); });
    await page.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('blob:') || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    const id = name => page.getByTestId(name);
    const open = async (scale = 1) => { await page.goto(`${base}/?screen=settings&fontScale=${scale}`); await id('settings-profile-image-select').waitFor(); };
    const select = async file => {
      const chooser = page.waitForEvent('filechooser'); await id('settings-profile-image-select').click();
      await (await chooser).setFiles(file);
    };
    const checkBounds = async (control, label) => {
      const bounds = await id(control).evaluate(element => {
        const box = element.getBoundingClientRect(), issues = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const range = document.createRange(); range.selectNodeContents(walker.currentNode);
          for (const glyph of range.getClientRects()) if (glyph.left < box.left - 1 || glyph.right > box.right + 1 || glyph.top < box.top - 1 || glyph.bottom > box.bottom + 1) issues.push(walker.currentNode.textContent);
        }
        return { issues, left: box.left, right: box.right, width: innerWidth };
      });
      assert.deepEqual(bounds.issues, [], `${label}/${control}`);
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width);
    };
    await open();
    const canceled = page.waitForEvent('filechooser'); await id('settings-profile-image-select').click();
    await canceled;
    await page.locator('input[type="file"]').dispatchEvent('cancel');
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-profile-image-select"]').getAttribute('aria-disabled') !== 'true');
    assert.equal(uploads.length, 0); assert.equal(me.profileImageUrl, null);
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fb4552'; ctx.fillRect(0, 0, 1600, 900);
      ctx.fillStyle = '#225bbb'; ctx.fillRect(600, 0, 400, 900);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const photo = { name: 'landscape.png', mimeType: 'image/png', buffer: Buffer.from(source, 'base64') };
    await select(photo); await id('settings-profile-avatar-image').waitFor();
    assert.equal(uploads.length, 1); assert.ok(uploads[0].size < 100000);
    const firstUrl = me.profileImageUrl;
    const output = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, firstUrl);
    assert.deepEqual(output, { width: 512, height: 512 });
    assert.equal(await page.evaluate(() => window.fixture.client.getQueryData(['me']).profileImageUrl), firstUrl);
    for (const [screen, avatar] of [['home', 'home-profile-avatar-image'], ['my', 'my-profile-avatar-image'], ['ranking', 'ranking-my-avatar-image']]) {
      await page.evaluate(screen => window.fixture.setScreen(screen), screen); await id(avatar).waitFor();
      assert.equal(await id(avatar).locator('img').getAttribute('src'), firstUrl);
    }
    await page.evaluate(() => window.fixture.setScreen('settings')); await id('settings-profile-image-select').waitFor();
    failNext = true; await select(photo); await id('settings-profile-image-error').waitFor();
    assert.equal(me.profileImageUrl, firstUrl); assert.match(await id('settings-profile-image-error').innerText(), /업로드하지 못했습니다/);
    await select(photo); await page.waitForFunction(previous => window.fixture.client.getQueryData(['me']).profileImageUrl !== previous, firstUrl);
    assert.equal(uploads.length, 2); assert.notEqual(me.profileImageUrl, firstUrl);
    await page.reload(); await id('settings-profile-avatar-image').waitFor();
    await id('settings-profile-image-delete').click(); await id('settings-profile-avatar-fallback').waitFor();
    assert.equal(me.profileImageUrl, null); assert.match(await id('settings-profile-image-select').innerText(), /사진 추가/);

    // EXIF orientation 6: a landscape JPEG must render as an oriented portrait
    // before the center crop. Normalized uploads must not preserve its EXIF.
    const orientedSource = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 800;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fb4552'; ctx.fillRect(0, 0, 1200, 800);
      ctx.fillStyle = '#225bbb'; ctx.fillRect(400, 0, 400, 800);
      return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    const originalJpeg = Buffer.from(orientedSource, 'base64'), exif = Buffer.alloc(32);
    exif.write('Exif', 0); exif.writeUInt16LE(0x4949, 6); exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10);
    exif.writeUInt16LE(1, 14); exif.writeUInt16LE(0x0112, 16); exif.writeUInt16LE(3, 18); exif.writeUInt32LE(1, 20); exif.writeUInt16LE(6, 24);
    const exifHeader = Buffer.from([0xff, 0xe1, 0, 34]);
    await select({ name: 'portrait-with-exif.jpg', mimeType: 'image/jpeg', buffer: Buffer.concat([originalJpeg.subarray(0, 2), exifHeader, exif, originalJpeg.subarray(2)]) });
    await page.waitForFunction(() => window.fixture.client.getQueryData(['me']).profileImageUrl !== null);
    const oriented = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return { centerLeft: [...ctx.getImageData(0, 256, 1, 1).data], topCenter: [...ctx.getImageData(256, 0, 1, 1).data] };
    }, me.profileImageUrl);
    assert.ok(oriented.centerLeft[2] > oriented.centerLeft[0]);
    assert.ok(oriented.topCenter[0] > oriented.topCenter[2]);
    assert.equal(fs.readFileSync(path.join(out, `upload-${uploads.length}.jpg`)).includes(Buffer.from('Exif')), false);

    // Small inputs stay small and are still re-encoded to JPEG.
    const beforeSmall = me.profileImageUrl;
    await select({ name: 'small.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(path.join(backend, 'test/fixtures/profile-image.jpg')) });
    await page.waitForFunction(previous => window.fixture.client.getQueryData(['me']).profileImageUrl !== previous, beforeSmall);
    const small = await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); return image.naturalWidth; }, me.profileImageUrl);
    assert.equal(small, 16);

    // Hold local responses to measure actual mutation labels at the smallest
    // viewport and largest font scale, including disabled neighboring actions.
    const pendingLayouts = [];
    for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width: 320, height: 900 }); await open(2);
      await page.evaluate(value => window.fixture.appearance.setPreference(value), appearance);
      for (const action of ['upload', 'delete']) {
        let release;
        nextMutationGate = new Promise(resolve => { release = resolve; });
        const previous = me.profileImageUrl;
        if (action === 'upload') await select(photo); else await id('settings-profile-image-delete').click();
        await page.getByText(action === 'upload' ? '업로드 중...' : '삭제 중...', { exact: true }).waitFor();
        for (const control of ['settings-profile-image-select', 'settings-profile-image-delete']) {
          assert.equal(await id(control).getAttribute('aria-disabled'), 'true');
          await checkBounds(control, `${appearance}/320/2/${action}`);
        }
        await page.screenshot({ path: path.join(out, `settings-${appearance}-320-2-${action}.png`) });
        pendingLayouts.push({ appearance, width: 320, fontScale: 2, action });
        release();
        await page.waitForFunction(old => window.fixture.client.getQueryData(['me']).profileImageUrl !== old, previous);
      }
      await select(photo); await id('settings-profile-avatar-image').waitFor();
    }

    for (const appearance of ['light', 'dark']) for (const width of [320, 360, 390, 430]) for (const scale of [1, 1.5, 2]) {
      await page.setViewportSize({ width, height: 900 }); await open(scale);
      await page.evaluate(value => window.fixture.appearance.setPreference(value), appearance);
      for (const control of ['settings-profile-image-select', 'settings-profile-image-delete']) {
        await checkBounds(control, `${appearance}/${width}/${scale}`);
      }
      layouts.push({ appearance, width, fontScale: scale });
      if (scale === 2 || (width === 390 && scale === 1)) await page.screenshot({ path: path.join(out, `settings-${appearance}-${width}-${scale}.png`) });
    }
    assert.deepEqual(failures, []);
    const report = { status: 'PASS', layouts: layouts.length, pendingLayouts, uploads, normalized: output, smallImageSide: small, flows: ['real Web file chooser', 'picker cancel event', 'PNG to square JPEG', 'EXIF orientation and removal', 'upload', 'replace', 'failure preserves URL', 'delete fallback', 'reload persistence', 'Home/My/Ranking propagation'], native: 'NOT_RUN' };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
