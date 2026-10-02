// Real RN Web components; only account/transport/navigation use fixtures.
const path = require("node:path"),
  fs = require("node:fs"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const esbuild = require("esbuild"),
  { chromium } = require("playwright");
const root = path.resolve(__dirname, "../.."),
  out =
    process.env.MARKET_EXECUTION_BROWSER_OUTPUT ?? "/tmp/b21-market-browser";
async function run() {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, "marketExecutionFixture.jsx")],
    outfile: path.join(out, "bundle.js"),
    bundle: true,
    minify: true,
    platform: "browser",
    format: "iife",
    nodePaths: [path.join(root, "node_modules")],
    resolveExtensions: [
      ".web.tsx",
      ".tsx",
      ".web.ts",
      ".ts",
      ".web.js",
      ".js",
      ".jsx",
      ".json",
    ],
    mainFields: ["browser", "module", "main"],
    define: {
      global: "globalThis",
      "process.env.NODE_ENV": '"production"',
      __DEV__: "false",
    },
    loader: { ".png": "dataurl" },
    plugins: [
      {
        name: "fixture",
        setup(b) {
          b.onResolve({ filter: /^react-native$/ }, () => ({
            path: path.join(__dirname, "nativeWeb.jsx"),
          }));
          b.onResolve(
            { filter: /^@react-navigation\/(native|elements)$/ },
            () => ({ path: path.join(__dirname, "marketExecutionMocks.js") }),
          );
          b.onResolve(
            {
              filter:
                /(services\/api\/client|TradingAccountContext|navigationHooks)$/,
            },
            () => ({ path: path.join(__dirname, "marketExecutionMocks.js") }),
          );
        },
      },
    ],
    logLevel: "warning",
  });
  fs.writeFileSync(
    path.join(out, "index.html"),
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>',
  );
  const server = http
    .createServer((req, res) => {
      const file = req.url.startsWith("/bundle.js")
        ? "bundle.js"
        : "index.html";
      res.setHeader(
        "Content-Type",
        file === "bundle.js" ? "text/javascript" : "text/html",
      );
      res.end(fs.readFileSync(path.join(out, file)));
    })
    .listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const browser = await chromium
      .launch({ headless: true, args: ["--no-sandbox"] })
      .catch((error) => {
        server.close();
        throw error;
      }),
    page = await browser.newPage(),
    errors = [],
    results = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route("**/*", (r) =>
    r.request().url().startsWith(base) ? r.continue() : r.abort(),
  );
  try {
    for (const width of [320, 360, 390, 430])
      for (const fontScale of [1, 1.5])
        for (const kind of [
          "quantity",
          "amount",
          "large",
          "full",
          "limit",
          "history",
        ]) {
          await page.setViewportSize({
            width,
            height: width === 320 ? 568 : 844,
          });
          await page.goto(`${base}/?kind=${kind}&fontScale=${fontScale}`);
          if (kind === "history")
            await page
              .getByText(/부분체결 · 잔량 자동취소/)
              .first()
              .waitFor();
          else {
            await page.getByTestId("order-success-actions").waitFor();
            const label =
              kind === "full"
                ? "주문이 완료되었습니다"
                : kind === "limit"
                  ? "지정가 매수 주문이 등록되었습니다."
                  : "일부 체결되었습니다";
            await page.getByText(label, { exact: true }).waitFor();
            await page.waitForTimeout(350);
            const actions = await page
              .getByTestId("order-success-actions")
              .boundingBox();
            assert.ok(
              actions.y >= 0 &&
                actions.y + actions.height <= page.viewportSize().height + 1,
              `${kind}/${width}: CTA inside viewport ${JSON.stringify(actions)}`,
            );
            if (!["full", "limit"].includes(kind)) {
              const note = page.getByTestId("market-remainder-message");
              await note.scrollIntoViewIfNeeded();
              assert.match(
                await note.innerText(),
                /시장 유동성 부족.*자동 취소/,
              );
            }
          }
          const overflows = await page.evaluate(() =>
            [...document.querySelectorAll("div,span")]
              .filter((el) => {
                const r = el.getBoundingClientRect(),
                  s = getComputedStyle(el);
                return (
                  r.width > 0 &&
                  r.height > 0 &&
                  (r.left < -1 ||
                    r.right > innerWidth + 1 ||
                    (el.children.length === 0 &&
                      el.scrollWidth > el.clientWidth + 1 &&
                      s.overflowX !== "auto"))
                );
              })
              .map((el) => ({
                text: el.textContent.slice(0, 100),
                width: el.clientWidth,
                scroll: el.scrollWidth,
              })),
          );
          assert.deepEqual(
            overflows,
            [],
            `${kind}/${width}/${fontScale} no horizontal text clipping`,
          );
          await page.screenshot({
            path: path.join(out, `${kind}-${width}-${fontScale}.png`),
            fullPage: true,
          });
          if (kind !== "history") {
            await page
              .getByRole("button", { name: "홈으로 가기", exact: true })
              .click();
            assert.equal(await page.evaluate(() => window.fixtureClosed), true);
          }
          results.push({ kind, width, fontScale, status: "PASS" });
        }
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, "validation.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(
      `PASS ${results.length} result/history layouts; artifacts: ${out}`,
    );
  } finally {
    await browser.close();
    server.close();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
