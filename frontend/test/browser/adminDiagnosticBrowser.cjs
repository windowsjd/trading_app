// Actual RN Web layout; reuse the existing external esbuild/Playwright setup.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild'), { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const out = process.env.ADMIN_DIAGNOSTIC_BROWSER_OUTPUT ?? '/tmp/trading-admin-diagnostic-browser';

async function run() {
  fs.mkdirSync(out, { recursive: true });
  const fixture = path.join(__dirname, 'adminDiagnosticFixture.jsx');
  await esbuild.build({
    entryPoints: [fixture], outfile: path.join(out, 'app.js'), bundle: true, minify: true,
    platform: 'browser', format: 'iife', nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.jsx', '.json'],
    mainFields: ['browser', 'module', 'main'], loader: { '.png': 'dataurl' },
    define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', 'process.env.EXPO_OS': '"web"', __DEV__: 'false' },
    plugins: [{ name: 'diagnostic-fixture-transport', setup(build) {
      build.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(__dirname, 'nativeWeb.jsx') }));
      build.onResolve({ filter: /services\/api\/client$/ }, () => ({ path: fixture }));
    } }], logLevel: 'warning',
  });
  const server = http.createServer((req, res) => {
    const js = req.url.startsWith('/app.js');
    res.setHeader('Content-Type', js ? 'text/javascript' : 'text/html');
    res.end(js ? fs.readFileSync(path.join(out, 'app.js')) : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/app.js"></script>');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  const results = [], errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
      ...(process.env.ADMIN_DIAGNOSTIC_CHROMIUM ? { executablePath: process.env.ADMIN_DIAGNOSTIC_CHROMIUM } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await page.addInitScript(() => localStorage.setItem('trading-app:appearance', new URLSearchParams(location.search).get('theme') ?? 'light'));
    const panel = () => page.getByTestId('admin-diagnostic-panel');
    const toggle = () => page.getByTestId('admin-diagnostic-toggle');
    async function open(query) { await page.goto(`${base}/?${query}`); await page.getByRole('button', { name: '다시 시도', exact: true }).waitFor(); }
    async function geometry() {
      const measured = await panel().evaluate(element => {
        const rect = element.getBoundingClientRect();
        const glyphs = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const range = document.createRange(); range.selectNode(walker.currentNode);
          for (const r of range.getClientRects()) if (r.width > 0 && (r.left < rect.left - 1 || r.right > rect.right + 1)) glyphs.push(walker.currentNode.textContent.slice(0, 80));
        }
        return { left: rect.left, right: rect.right, overflow: glyphs, pageOverflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(measured.left >= 0 && measured.right <= page.viewportSize().width, true, JSON.stringify(measured));
      assert.equal(measured.pageOverflow, false, JSON.stringify(measured));
      assert.equal(measured.overflow.length, 0, JSON.stringify(measured));
      assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_FIXTURE/);
    }
    for (const width of [320, 390]) for (const fontScale of [1, 2]) for (const theme of ['light', 'dark']) for (const surface of ['page', 'inline']) {
      await page.setViewportSize({ width, height: 568 });
      await open(`fontScale=${fontScale}&theme=${theme}&surface=${surface}`);
      await panel().waitFor(); assert.equal(await page.getByTestId('admin-diagnostic-content').count(), 0);
      await geometry(); await toggle().click(); await page.getByTestId('admin-diagnostic-content').waitFor(); await geometry();
      assert.match((await panel().innerText()).replace(/\u200b/g, ''), /transfer_destination_credit|walletTransfer\.ts/);
      if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `expanded-${surface}-${theme}.png`) });
      const retry = page.getByRole('button', { name: '다시 시도', exact: true });
      await retry.scrollIntoViewIfNeeded();
      const retryBox = await retry.boundingBox(), toggleBox = await toggle().boundingBox();
      assert.equal(retryBox.y >= toggleBox.y + toggleBox.height, true, 'retry and toggle touch targets remain separate');
      assert.equal(retryBox.y >= 0 && retryBox.y + retryBox.height <= 569, true, 'retry remains reachable by scrolling');
      if (width === 320 && fontScale === 2) await page.screenshot({ path: path.join(out, `bottom-${surface}-${theme}.png`) });
      await toggle().click(); assert.equal(await page.getByTestId('admin-diagnostic-content').count(), 0);
      await retry.click(); await page.getByTestId('diagnostic-recovered').waitFor(); assert.equal(await panel().count(), 0);
      assert.equal(await page.evaluate(() => window.diagnosticFixture.retries), 1);
      results.push({ width, fontScale, theme, surface, layout: 'pass', expandCollapse: 'pass', scrollRetry: 'pass' });
    }
    for (const query of ['role=user', 'role=operator', 'unresolved=1', 'meFailure=1&cachedAdmin=1']) {
      await open(query);
      await page.waitForFunction(() => window.diagnosticFixture.meReads > 0);
      await page.waitForTimeout(50);
      assert.equal(await panel().count(), 0, query);
      assert.doesNotMatch(await page.locator('body').innerText(), /PRIVATE_FIXTURE|transfer_destination_credit|backend\/src/);
      results.push({ gate: query, result: 'pass' });
    }
    await open(''); await panel().waitFor(); await toggle().click();
    await page.evaluate(() => window.diagnosticFixture.clearRole()); await panel().waitFor({ state: 'hidden' });
    await page.evaluate(() => window.diagnosticFixture.installUser('admin', 'admin-B'));
    await page.waitForTimeout(50); assert.equal(await panel().count(), 0, 'incoming admin cannot see the old diagnostic');
    await page.evaluate(() => window.diagnosticFixture.newFailure()); await panel().waitFor();
    if (await page.getByTestId('admin-diagnostic-content').count() === 0) await toggle().click();
    await page.getByTestId('admin-diagnostic-content').waitFor();
    assert.match((await panel().innerText()).replace(/\u200b/g, ''), /B-request/);
    results.push({ gate: 'clear /me → admin-B → new failure', result: 'pass' });
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 2));
    console.log(`Admin diagnostic browser PASS: ${results.length} scenarios`);
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
