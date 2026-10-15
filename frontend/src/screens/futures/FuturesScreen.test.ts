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
      assert.equal(h.node('futures-leverage-select') === undefined, true, 'a position keeps its leverage');
      if (op !== 'close') {
        assert.equal(h.node('futures-submit').props.state, 'disabled', 'selecting an operation still requires a valid amount');
        // $51 at Futures Last 102 is 0.5 contracts.
        await h.amount('51');
      }
      assert.equal(h.node('futures-submit').props.state, 'enabled');
    }
  }
});

test('the card TP/SL entrance opens that position\'s TP/SL panel in the card: one panel manages the existing group, never a duplicate registration', async t => {
  const h = futuresHarness({ position: true, protectionEnabled: true });
  h.protectionOptions = { active: true };
  await h.start(); t.after(h.close);
  const panels = () => h.renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'protection-panel').length;
  // The card reads the live group at a glance: TP / SL triggers.
  assert.equal(h.node('futures-position-A:position-protection-status').props.children, '$123,456,789.12 / $90,000');
  assert.equal(h.node('futures-position-A:position-protection').props.label, 'TP/SL 관리');
  assert.equal(panels(), 0);
  await h.press('futures-position-A:position-protection');
  // TP/SL is managed in the position card; the trade form keeps its method.
  assert.equal(h.orderType(), '시장가');
  assert.equal(panels(), 1);
  const inCard = h.node('futures-position-A:position').findAll((n: any) => typeof n.type === 'string' && n.props.testID === 'protection-panel').length;
  assert.equal(inCard, 1);
  assert.equal(h.node('futures-position-A:position-protection').props.label, 'TP/SL 접기');
  assert.equal(h.node('protection-stop_loss-toggle') === undefined, true);
  assert.equal(h.renderer.root.findAllByType('CTAButton').some(n => n.props.label === '보호 조건 취소'), true);
  assert.equal(h.node('futures-conditional-fields') === undefined, true, 'TP/SL is not a new-position 조건주문');
  assert.equal(h.requests.length, 0);
  await h.press('futures-position-A:position-protection');
  assert.equal(panels(), 0);
  assert.equal(h.requests.length, 0);
});

test('주문방식 starts at 시장가 and offers only 시장가, 지정가 and 조건주문; flat 조건주문 is a new-position entry, held 지정가/조건주문 explain why they wait', async t => {
  const methods = (h: any) => ['market', 'limit', 'conditional', 'loc', 'protection'].filter(m => h.node(`order-method-${m}`) !== undefined);
  const flat = futuresHarness({ protectionEnabled: true });
  await flat.start(); t.after(flat.close);
  assert.equal(flat.orderType(), '시장가');
  assert.equal(flat.node('order-type-select').props.accessibilityLabel, '주문방식 시장가, 주문방식 선택하기');
  await flat.press('order-type-select');
  assert.deepEqual(methods(flat), ['market', 'limit', 'conditional']);
  assert.equal(flat.node('order-method-conditional').props.disabled, false);
  await flat.press('order-method-conditional');
  assert.equal(flat.orderType(), '조건주문');
  assert.equal(flat.node('futures-conditional-trigger-price').props.value, '');
  assert.equal(flat.node('futures-submit') === undefined, true, 'a conditional entry registers through its own form');
  const tradeCardPanels = flat.node('futures-trade').findAll((n: any) => typeof n.type === 'string' && n.props.testID === 'protection-panel').length;
  assert.equal(tradeCardPanels, 0, 'a new-position 조건주문 is not position TP/SL');
  await flat.selectMethod('limit');
  assert.equal(flat.orderType(), '지정가');
  assert.equal(flat.node('futures-limit-price').props.value, '');
  assert.equal(flat.node('futures-submit') === undefined, true, 'the limit entry submits through its own form');
  const held = futuresHarness({ position: true, protectionEnabled: true });
  await held.start(); t.after(held.close);
  assert.equal(held.orderType(), '시장가');
  await held.press('order-type-select');
  assert.deepEqual(methods(held), ['market', 'limit', 'conditional']);
  assert.equal(held.node('order-method-limit').props.disabled, true);
  assert.equal(held.node('order-method-conditional').props.disabled, true);
  assert.equal(held.node('order-method-conditional-badge').props.children, '이용 불가');
  await held.press('order-method-conditional');
  assert.equal(held.orderType(), '시장가', 'a refused choice keeps the method');
  await held.press('order-method-limit');
  assert.equal(held.orderType(), '시장가');
  assert.equal(held.requests.length + flat.requests.length, 0);
});

test('a contract change starts at 시장가 with the entry draft cleared', async t => {
  const h = futuresHarness({ futuresOnly: true });
  await h.start(); t.after(h.close);
  await h.selectMethod('limit');
  await h.change('futures-limit-price', '100');
  await h.amount('100');
  await h.selectInstrument('hype');
  assert.equal(h.orderType(), '시장가');
  assert.equal(h.node('futures-amount').props.value, '', 'another contract never inherits the amount');
  assert.equal(h.node('futures-limit-price') === undefined, true);
  await h.selectMethod('limit');
  assert.equal(h.node('futures-limit-price').props.value, '');
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
          // Mark = Last: no entry starts under maintenance (the Mark check has its own test).
          const h = futuresHarness({ accountId, markPrice: "102" });
          await h.start();
          t.after(h.close);
          await h.choose(direction);
          await h.choose(marginMode);
          await h.setLeverage(leverage);
          assert.equal(h.leverage(), `${leverage}x`);
          // $127.50 at Futures Last 102 is 1.25 contracts.
          await h.amount("127.5");
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
      if (op !== "close") await h.amount("51");
      assert.equal(h.node("futures-leverage-select") === undefined, true);
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
    await h.amount("51");
    assert.equal(h.node("futures-submit").props.state, "disabled");
    assert.match(h.text(), /Mark 확인 불가/);
    assert.doesNotMatch(h.text(), /99\.5/);
    await h.choose("수량 감소(Reduce)");
    // A reduce amount is entered for the reduce itself (an add amount never carries over).
    assert.equal(h.node("futures-amount").props.value, "");
    await h.amount("51");
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
  await h.amount("102");
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
  await h.amount("102");
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
  await h.amount("102");
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
  await h.view("history");
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
  await h.amount("102");
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

test("opening with no free collateral is refused on press; reduce and unknown collateral are not", async (t) => {
  const h = futuresHarness({ freeCollateral: "0.00000000" });
  await h.start();
  t.after(h.close);
  await h.amount("102");
  assert.equal(h.node("futures-submit").props.state, "enabled");
  await h.press("futures-submit");
  assert.equal(h.requests.length, 0);
  assert.equal(h.node("futures-order-notice")?.props.children, "사용 가능한 담보가 부족합니다. 주문 금액이나 레버리지를 조정해주세요.");
  assert.equal(h.node("futures-submit").props.state, "enabled");
  await h.press("futures-submit");
  assert.equal(h.requests.length, 0, "the server is never asked for a certain rejection");
  const unknown = futuresHarness({ freeCollateral: null });
  await unknown.start();
  t.after(unknown.close);
  await unknown.amount("102");
  assert.equal(unknown.node("futures-collateral-insufficient") === undefined, true, "unknown never counts as short");
  const reducing = futuresHarness({ position: true, freeCollateral: "0.00000000" });
  await reducing.start();
  t.after(reducing.close);
  await reducing.press("futures-position-A:position-reduce");
  await reducing.amount("51");
  assert.equal(reducing.node("futures-collateral-insufficient") === undefined, true, "risk reduction needs no new collateral");
});
