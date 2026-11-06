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
  // `sell:<state>`: an executed SELL whose 공유하기 check answers <state>, in both themes and up to 2× text.
  const scenarios = [];
  for (const width of [320, 360, 390, 430])
    for (const fontScale of [1, 1.5, 2])
      for (const kind of [
        "quantity",
        "amount",
        "large",
        "full",
        "limit",
        "history",
        "sell:ready",
        "sell:holding",
        "sell:unverified",
        "sell:failed",
        "sell:checking",
      ])
        for (const theme of kind.startsWith("sell") ? ["light", "dark"] : ["light"])
          // The 16-digit `large` fixture clips its quantity at 2× text before 2026-11-06 too (HEAD copy).
          if (!(kind === "large" && fontScale === 2)) scenarios.push({ width, fontScale, kind, theme });
  const shareNotes = {
    holding: /^보유 수량을 모두 매도해 거래가 완료되면 공유할 수 있어요\.$/,
    unverified: /^이 매도로 완료된 거래를 확인하지 못했어요\. 거래 내역의 거래 완료에서 확인해 주세요\.$/,
    failed: /^공유할 수 있는지 확인하지 못했어요\. 다시 눌러 주세요\.$/,
  };
  await page.addInitScript(() => localStorage.setItem("trading-app:appearance", "system"));
  try {
    for (const { width, fontScale, kind: scenario, theme } of scenarios) {
          const [kind, share] = scenario.split(":");
          await page.setViewportSize({
            width,
            height: width === 320 ? 568 : 844,
          });
          await page.emulateMedia({ colorScheme: theme });
          await page.goto(`${base}/?kind=${kind}&fontScale=${fontScale}${share ? `&share=${share}` : ""}`);
          if (kind === "history")
            await page
              .getByText(/부분체결 · 잔량 자동취소/)
              .first()
              .waitFor();
          else {
            await page.getByTestId("order-success-actions").waitFor();
            const label =
              kind === "full" || kind === "sell"
                ? "주문이 완료되었습니다"
                : kind === "limit"
                  ? "지정가 매수 주문이 등록되었습니다."
                  : "일부 체결되었습니다";
            await page.getByText(label, { exact: true }).waitFor();
            const shareButton = page.getByTestId("order-success-share");
            if (kind !== "sell") assert.equal(await shareButton.count(), 0, `${scenario}: a BUY has no 공유하기`);
            else {
              await shareButton.waitFor();
              if (shareNotes[share]) {
                const note = page.getByTestId("order-success-share-note");
                await note.waitFor();
                assert.match(await note.innerText(), shareNotes[share], scenario);
              } else assert.equal(await page.getByTestId("order-success-share-note").count(), 0, scenario);
              if (share === "ready")
                await page.waitForFunction(() => document.querySelector('[data-testid="order-success-share"]')?.getAttribute("aria-disabled") !== "true");
              const disabled = await shareButton.getAttribute("aria-disabled");
              assert.equal(disabled === "true", ["holding", "unverified", "checking"].includes(share), `${scenario}: 공유하기 disabled=${disabled}`);
            }
            await page.waitForTimeout(350);
            const title = await page.getByText(label, { exact: true }).boundingBox();
            assert.ok(title.y >= 0, `${scenario}/${width}/${fontScale}: the title stays on screen ${JSON.stringify(title)}`);
            const actions = await page
              .getByTestId("order-success-actions")
              .boundingBox();
            assert.ok(
              actions.y >= 0 &&
                actions.y + actions.height <= page.viewportSize().height + 1,
              `${kind}/${width}: CTA inside viewport ${JSON.stringify(actions)}`,
            );
            if (!["full", "limit", "sell"].includes(kind)) {
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
            path: path.join(out, `${scenario.replace(":", "-")}-${width}-${fontScale}-${theme}.png`),
            fullPage: true,
          });
          if (scenario === "sell:ready") {
            // 공유하기 → the 수익 공유 sheet in place of the result; closing it brings the result back.
            await page.getByTestId("order-success-share").click();
            await page.getByTestId("trade-share-body").waitFor();
            await page.waitForFunction(() => !document.querySelector('[data-testid="order-success-actions"]'));
            await page.waitForTimeout(450);
            await page.screenshot({ path: path.join(out, `sell-sharing-${width}-${fontScale}-${theme}.png`) });
            await page.getByTestId("trade-share-sheet-close").click();
            await page.getByTestId("order-success-actions").waitFor();
            assert.equal(await page.evaluate(() => window.fixtureClosed), false, `${scenario}: sharing never closes the result`);
          }
          if (kind === "sell") {
            await page
              .getByRole("button", { name: "주문으로 돌아가기", exact: true })
              .click();
            assert.equal(await page.evaluate(() => window.fixtureClosed), true);
          } else if (kind !== "history") {
            await page
              .getByRole("button", { name: "홈으로 가기", exact: true })
              .click();
            assert.equal(await page.evaluate(() => window.fixtureClosed), true);
          }
          results.push({ kind: scenario, width, fontScale, theme, status: "PASS" });
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
