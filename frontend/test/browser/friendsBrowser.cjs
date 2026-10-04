// Run with esbuild/playwright on NODE_PATH; all fixture transport stays local.
const path = require('node:path'),
  fs = require('node:fs'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const theme = require('./appearanceAssertions.cjs');
const esbuild = require('esbuild'),
  { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..'),
  out = process.env.FRIENDS_BROWSER_OUTPUT ?? '/tmp/trading-friends-browser';
async function main() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'friendsFixture.jsx')],
    outfile: path.join(out, 'bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    nodePaths: [path.join(root, 'node_modules')],
    resolveExtensions: [
      '.web.tsx',
      '.tsx',
      '.ts',
      '.web.js',
      '.js',
      '.jsx',
      '.json',
    ],
    mainFields: ['browser', 'module', 'main'],
    define: {
      global: 'globalThis',
      'process.env.NODE_ENV': '"production"',
      __DEV__: 'false',
    },
    plugins: [
      {
        name: 'fixture-boundaries',
        setup(b) {
          b.onResolve({ filter: /^react-native$/ }, () => ({
            path: path.join(__dirname, 'nativeWeb.jsx'),
          }));
          b.onResolve(
            {
              filter:
                /(^@react-navigation\/native$|services\/api\/client$|features\/auth\/useLogout$)/,
            },
            () => ({ path: path.join(__dirname, 'friendsMocks.js') }),
          );
        },
      },
    ],
  });
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>';
  const server = http
    .createServer((req, res) => {
      res.setHeader(
        'Content-Type',
        req.url.startsWith('/bundle.js') ? 'text/javascript' : 'text/html',
      );
      res.end(
        req.url.startsWith('/bundle.js')
          ? fs.readFileSync(path.join(out, 'bundle.js'))
          : html,
      );
    })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  const results = [],
    errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort(),
    );
    for (const appearance of ['light', 'dark'])
    for (const width of [320, 390, 768])
      for (const fontScale of [1, 2])
        for (const screen of [
          'overall',
          'friends',
          'notices',
          'settings',
          'summary',
        ]) {
          await page.setViewportSize({ width, height: 844 });
          await page.emulateMedia({ colorScheme: appearance });
          await page.goto(`${base}/?screen=${screen}&fontScale=${fontScale}`);
          await page
            .getByText(
              screen === 'overall'
                ? 'MY'
                : screen === 'friends'
                  ? '친구 목록'
                  : screen === 'notices'
                    ? '등록된 공지사항이 없습니다.'
                    : screen === 'settings'
                      ? '닉네임 변경'
                      : '최근 30일 자산 / 수익률 추이',
              { exact: true },
            )
            .waitFor();
          await theme.canvas(page, appearance);
          if (screen === 'overall') await theme.background(page.getByText('MY', { exact: true }), appearance, 'surface');
          if (screen === 'friends') {
            await theme.background(page.getByText('친구 목록', { exact: true }).locator('..').locator('..'), appearance, 'surface');
          }
          if (screen === 'settings') {
            await theme.background(page.getByText('닉네임 변경', { exact: true }), appearance, 'surface');
            await theme.background(page.getByPlaceholder('닉네임 입력'), appearance, 'raised');
          }
          if (screen === 'summary') await theme.background(page.getByText('최근 30일 자산 / 수익률 추이', { exact: true }), appearance, 'surface');
          const overflow = await page.evaluate(() =>
            [...document.querySelectorAll('#root *')]
              .filter((el) => el.children.length === 0 && el.textContent.trim())
              .map((el) => ({
                text: el.textContent,
                rect: el.getBoundingClientRect(),
                scroll: el.scrollWidth,
                client: el.clientWidth,
              }))
              .filter(
                ({ rect, scroll, client }) =>
                  rect.width > 0 &&
                  (rect.right > innerWidth + 1 ||
                    rect.left < -1 ||
                    scroll > client + 1),
              )
              .map(({ text }) => text),
          );
          assert.deepEqual(
            overflow,
            [],
            `${screen} width ${width} scale ${fontScale}`,
          );
          results.push({ screen, appearance, width, fontScale, overflow });
          if (width === 320 && fontScale === 2)
            await page.screenshot({
              path: path.join(out, `${screen}-${appearance}-320-scale2.png`),
              fullPage: true,
            });
        }
    await page.goto(`${base}/?screen=settings`);
    await page.getByRole('radio', { name: '라이트', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.style.colorScheme === 'light');
    await theme.canvas(page, 'light');
    await page.reload();
    await page.getByPlaceholder('닉네임 입력').waitFor();
    await theme.canvas(page, 'light'); // saved choice overrides the dark OS setting
    await page.getByRole('radio', { name: '다크', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.style.colorScheme === 'dark');
    await theme.canvas(page, 'dark');
    await page.getByRole('radio', { name: '시스템', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.style.colorScheme === 'light');
    await theme.canvas(page, 'light');
    const toggle = page.getByRole('switch', { name: '친구에게 포트폴리오 공개', exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), true);
    await toggle.click();
    await page.getByText('비공개', { exact: true }).waitFor();
    for (const access of ['private', 'not_friend']) {
      await page.goto(`${base}/?screen=summary&access=${access}`);
      await page
        .getByText(
          access === 'private'
            ? '이 사용자는 포트폴리오를 비공개로 설정했습니다.'
            : '친구 요청을 수락한 사용자만 포트폴리오를 볼 수 있습니다.',
        )
        .waitFor();
      assert.equal(
        await page.getByText('BTCUSDT', { exact: false }).count(),
        0,
      );
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, 'results.json'),
      JSON.stringify({ results, errors, privacy: 'passed' }, null, 2),
    );
    console.log(
      `friends browser ok (${results.length} layouts; privacy toggle and locked states)`,
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
