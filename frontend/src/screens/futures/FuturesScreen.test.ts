import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const { futuresHarness, deferred } = createRequire(import.meta.url)(
  "../../../test/futuresHarness.cjs",
);

for (const mode of ['ENABLED', 'REDUCE_ONLY', 'DISABLED']) test(`${mode}: detailed card selects the existing trade form without submitting and keeps capability restrictions`, async t => {
  const h = futuresHarness({ position: true, mode });
  await h.start(); t.after(h.close);
  for (const op of ['increase', 'reduce', 'close']) {
    const action = h.node(`futures-position-A:position-${op}`);
    assert.equal(action.props.state, (mode === 'DISABLED' || (mode === 'REDUCE_ONLY' && op === 'increase')) ? 'disabled' : 'enabled');
    if (action.props.state === 'enabled') {
      await h.press(`futures-position-A:position-${op}`);
      assert.equal(h.requests.length, 0);
      assert.equal(h.node('futures-leverage') === undefined, true);
      if (op !== 'close') {
        assert.equal(h.node('futures-submit').props.state, 'disabled', 'selecting an operation still requires a valid quantity');
        await h.change('futures-quantity', '0.5');
      }
      assert.equal(h.node('futures-submit').props.state, 'enabled');
    }
  }
});

test('the detailed TP/SL entrance manages one existing group and never opens a duplicate registration', async t => {
  const h = futuresHarness({ position: true, protectionEnabled: true });
  h.protectionOptions = { active: true };
  await h.start(); t.after(h.close);
  assert.equal(h.renderer.root.findAllByType('Text').some(n => [n.props.children].flat().join('') === 'TP/SL 보호 중'), true);
  assert.equal(h.node('protection-stop_loss-toggle') === undefined, true);
  await h.press('futures-protection-A:position');
  assert.equal(h.renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'protection-panel').length, 1);
  assert.equal(h.node('protection-stop_loss-toggle') === undefined, true);
  assert.equal(h.renderer.root.findAllByType('CTAButton').some(n => n.props.label === '보호 조건 취소'), true);
  assert.equal(h.requests.length, 0);
  await h.press('futures-protection-A:position');
  assert.equal(h.requests.length, 0);
});

test('closing from the detailed card sends the existing captured quantity and removes the refreshed open position', async t => {
  const h = futuresHarness({ position: true });
  await h.start(); t.after(h.close);
  await h.press('futures-position-A:position-close');
  assert.equal(h.requests.length, 0);
  h.options.position = false;
  await h.press('futures-submit');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.operation, 'close');
  assert.equal(h.requests[0].body.quantity, '2');
  assert.equal(h.node('futures-position-A:position') === undefined, true);
  assert.equal(h.invalidations.some(key => key.includes('A') && key.includes('futures')), true);
  assert.equal(h.reads.filter(path => path.endsWith('/futures/positions')).length >= 2, true);
});
test("Reduce/Close accepts a quiet market's re-confirmed older Futures Last trade", async (t) => {
  const h = futuresHarness({ position: true, stale: true, oldReference: true });
  await h.start();
  t.after(h.close);
  assert.match(h.text(), /현재가 · 선물 Last 거래 기준/);
  await h.choose("전량 종료(Close)");
  assert.equal(h.node("futures-submit").props.state, "enabled");
  await h.press("futures-submit");
  assert.equal(h.requests[0].body.operation, "close");
});
test("a Futures Last trade older than 60 seconds is not shown or executable", async (t) => {
  const h = futuresHarness({ position: true, stale: true, expiredReference: true });
  await h.start();
  t.after(h.close);
  assert.match(h.text(), /시세 확인 불가/);
  await h.choose("전량 종료(Close)");
  assert.equal(h.node("futures-submit").props.state, "disabled");
  assert.equal(h.requests.length, 0);
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
      assert.equal(h.node("futures-leverage") === undefined, true);
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
  assert.equal(h.node("futures-submit") === undefined, true);
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
