import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const { futuresHarness, deferred } = createRequire(import.meta.url)(
  "../../../test/futuresHarness.cjs",
);
test("Reduce/Close uses the F1 captured-age rule even when the provider effective time is older", async (t) => {
  const h = futuresHarness({ position: true, stale: true, oldReference: true });
  await h.start();
  t.after(h.close);
  await h.choose("전량 종료(Close)");
  assert.equal(h.node("futures-submit").props.state, "enabled");
  await h.press("futures-submit");
  assert.equal(h.requests[0].body.operation, "close");
});
for (const accountId of ["A", "B"])
  for (const direction of ["롱(Long)", "숏(Short)"])
    for (const marginMode of ["격리(Isolated)", "교차(Cross)"])
      for (const leverage of [1, 37, 100])
        test(`${accountId} ${direction} ${marginMode} ${leverage}x opens through account API`, async (t) => {
          const h = futuresHarness({ accountId });
          await h.start();
          t.after(h.close);
          await h.choose(direction);
          await h.choose(marginMode);
          await h.change("futures-leverage", String(leverage));
          await h.change("futures-quantity", "1.25");
          assert.equal(h.node("futures-submit").props.state, "enabled");
          await h.press("futures-submit");
          assert.equal(h.requests.length, 1);
          const request = h.requests[0];
          assert.equal(
            request.path,
            `/trading-accounts/${accountId}/futures/execute`,
          );
          assert.equal(
            request.body.direction,
            direction.startsWith("롱") ? "long" : "short",
          );
          assert.equal(
            request.body.marginMode,
            marginMode.startsWith("격리") ? "isolated" : "cross",
          );
          assert.equal(request.body.leverage, leverage);
          assert.equal(request.body.quantity, "1.25");
          assert.match(h.text(), /체결 완료/);
          assert.ok(
            h.invalidations.some(
              (key) => key.includes(accountId) && key.includes("wallets"),
            ),
          );
        });
for (const op of ["increase", "reduce", "close"])
  for (const marginMode of ["isolated", "cross"])
    test(`${op} keeps lifetime direction, leverage and ${marginMode}`, async (t) => {
      const h = futuresHarness({
        position: true,
        direction: "short",
        marginMode,
        leverage: 37,
      });
      await h.start();
      t.after(h.close);
      const labels = {
        increase: "수량 추가(Increase)",
        reduce: "수량 감소(Reduce)",
        close: "전량 종료(Close)",
      };
      await h.choose(labels[op]);
      if (op !== "close") await h.change("futures-quantity", "0.5");
      assert.equal(h.node("futures-leverage"), undefined);
      await h.press("futures-submit");
      assert.equal(h.requests[0].body.direction, "short");
      assert.equal(h.requests[0].body.leverage, 37);
      assert.equal(h.requests[0].body.marginMode, marginMode);
      assert.equal(h.requests[0].body.quantity, op === "close" ? "2" : "0.5");
      if (marginMode === "cross") assert.doesNotMatch(h.text(), /예상 청산가/);
    });
for (const mode of ["ENABLED", "REDUCE_ONLY", "DISABLED"])
  test(`${mode} follows server capability and stale Mark still permits reduction`, async (t) => {
    const h = futuresHarness({ position: true, stale: true, mode });
    await h.start();
    t.after(h.close);
    await h.change("futures-quantity", "0.5");
    assert.equal(h.node("futures-submit").props.state, "disabled");
    assert.match(h.text(), /Mark 확인 불가/);
    assert.doesNotMatch(h.text(), /99\.5/);
    await h.choose("수량 감소(Reduce)");
    assert.equal(
      h.node("futures-submit").props.state,
      mode === "DISABLED" ? "disabled" : "enabled",
    );
    await h.choose("전량 종료(Close)");
    assert.equal(
      h.node("futures-submit").props.state,
      mode === "DISABLED" ? "disabled" : "enabled",
    );
  });
test("uncertain execution retries its committed idempotency key; duplicate clicks submit once", async (t) => {
  const h = futuresHarness();
  await h.start();
  t.after(h.close);
  await h.change("futures-quantity", "1");
  h.failure = new Error("network");
  h.gate = deferred();
  await h.press("futures-submit");
  await h.press("futures-submit");
  assert.equal(h.requests.length, 1);
  h.gate.resolve();
  await h.flush();
  h.gate = null;
  h.failure = null;
  await h.press("futures-retry");
  assert.deepEqual(h.requests[1], h.requests[0]);
  assert.match(h.text(), /체결 완료/);
});
test("route-bound account and scope epoch suppress a late A mutation after A→B→A", async (t) => {
  const h = futuresHarness();
  await h.start();
  t.after(h.close);
  await h.change("futures-quantity", "1");
  h.gate = deferred();
  await h.press("futures-submit");
  h.accountId = "B";
  await h.update();
  assert.match(h.text(), /선택한 계정이 변경/);
  h.accountId = "A";
  await h.update();
  h.gate.resolve();
  await h.flush();
  assert.doesNotMatch(h.text(), /체결 완료/);
  assert.ok(
    h.invalidations
      .filter((key) => key[0] === "tradingAccount")
      .every((key) => !key.includes("B")),
  );
});
test("logout/login generation suppresses old success and cache invalidation", async (t) => {
  const h = futuresHarness();
  await h.start();
  t.after(h.close);
  await h.change("futures-quantity", "1");
  h.gate = deferred();
  await h.press("futures-submit");
  h.session++;
  h.gate.resolve();
  await h.flush();
  assert.doesNotMatch(h.text(), /체결 완료/);
  assert.equal(h.invalidations.length, 0);
});
test("liquidation history exposes economic loss, actual cash and shortfall separately", async (t) => {
  const h = futuresHarness({ position: true, marginMode: "cross" });
  await h.start();
  t.after(h.close);
  await h.choose("강제청산 기록");
  assert.match(h.text(), /경제적 실현 손익/);
  assert.match(h.text(), /실제 현금 정산/);
  assert.match(h.text(), /미충당 손실/);
  assert.doesNotMatch(h.text(), /예상 청산가/);
});
test("scope mismatch and failed refresh hide financial data", async (t) => {
  const h = futuresHarness();
  h.wrongScope = "B";
  await h.start();
  t.after(h.close);
  assert.match(h.text(), /불러오지 못했습니다/);
  assert.equal(h.node("futures-submit"), undefined);
});

test("uncertain open replays the original command after poll shows a position and mode becomes DISABLED", async (t) => {
  const h = futuresHarness();
  await h.start();
  t.after(h.close);
  await h.change("futures-quantity", "1");
  h.failure = new Error("lost response");
  await h.press("futures-submit");
  h.options.position = true;
  h.options.mode = "DISABLED";
  await h.client.invalidateQueries();
  await h.flush();
  assert.equal(h.node("futures-submit").props.state, "disabled");
  h.failure = null;
  await h.press("futures-retry");
  assert.deepEqual(h.requests[1], h.requests[0]);
  assert.equal(h.requests[1].body.operation, "open");
});
