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

const words = (node: any) => [node?.props.children].flat(Infinity).filter((part: unknown) => typeof part === 'string').join('');

test('the card 손절가/익절가 설정 opens that position\'s sheet; an existing OCO group shows there with its cancel and blocks new settings', async t => {
  const h = futuresHarness({ position: true, protectionEnabled: true });
  // A whole-position group registered before 2026-10-16 on this lifetime.
  h.protectionOptions = { active: true, positionId: 'A:position' };
  await h.start(); t.after(h.close);
  const card = 'futures-position-A:position-protection';
  assert.equal(h.node(card).props.label, '손절가/익절가 설정');
  assert.equal(h.node('tp-sl-futures-position') === undefined, true);
  await h.press(card);
  assert.equal(h.orderType(), '시장가', 'the trade form keeps its method');
  assert.equal(h.node('tp-sl-futures-position') !== undefined, true, 'the position sheet is open');
  assert.equal(h.node('tp-sl-legacy-oco') !== undefined, true, 'the existing OCO group is shown');
  assert.equal(h.node('tp-sl-legacy-oco-cancel').props.label, '기존 TP/SL(OCO) 취소');
  assert.match(words(h.node('tp-sl-blocked')), /기존 TP\/SL\(OCO\) 보호가 있어 함께 설정할 수 없어요/);
  assert.equal(h.node('tp-sl-take-profit-toggle').props.disabled, true, 'no new setting next to the group');
  assert.equal(h.node('tp-sl-submit').props.state, 'disabled');
  assert.equal(h.node('futures-conditional-fields') === undefined, true, '손절가/익절가 is not a new-position 조건주문');
  assert.equal(h.requests.length, 0);
  await h.press('tp-sl-legacy-oco-cancel');
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].path, /^\/trading-accounts\/A\/protections\/[^/]+\/cancel$/);
});

test('a Long position registers independent partial 손절가/익절가 on Futures Last: shares become contract quantities to reduce', async t => {
  const h = futuresHarness({ position: true });
  await h.start(); t.after(h.close);
  await h.press('futures-position-A:position-protection');
  assert.match(words(h.node('tp-sl-position')), /포지션 수량 2 BTC/);
  await h.press('tp-sl-take-profit-toggle');
  await h.change('tp-sl-take-profit-trigger-price', '110');
  await h.press('tp-sl-take-profit-ratio-25');
  assert.match(words(h.node('tp-sl-take-profit-quantity')), /^감소 수량 0\.5 BTC/);
  await h.press('tp-sl-stop-loss-toggle');
  await h.change('tp-sl-stop-loss-trigger-price', '95');
  await h.press('tp-sl-stop-loss-ratio-100');
  assert.match(words(h.node('tp-sl-stop-loss-quantity')), /^감소 수량 2 BTC/);
  assert.equal(h.node('tp-sl-take-profit-warning') === undefined && h.node('tp-sl-stop-loss-warning') === undefined, true);
  await h.press('tp-sl-submit');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, '/trading-accounts/A/futures/tp-sl-settings');
  assert.deepEqual({ ...h.requests[0].body, idempotencyKey: '<key>' }, {
    positionId: 'A:position', takeProfit: { triggerPrice: '110', quantity: '0.5' }, stopLoss: { triggerPrice: '95', quantity: '2' }, idempotencyKey: '<key>',
  });
  assert.match(h.requests[0].body.idempotencyKey, /^futures_tp_sl_/);
  assert.equal(words(h.node('tp-sl-registered')), '익절가와 손절가를 등록했어요.');
  // Nothing opened, increased or flipped the position: the only request was the settings.
  assert.equal(h.requests.some((r: { path: string }) => r.path.endsWith('/execute')), false);
});

test('a Short position watches the other sides: a take-profit above Futures Last is flagged as already reached', async t => {
  const h = futuresHarness({ position: true, direction: 'short' });
  await h.start(); t.after(h.close);
  await h.press('futures-position-A:position-protection');
  await h.press('tp-sl-take-profit-toggle');
  assert.equal(h.node('tp-sl-take-profit-trigger-price').props.placeholder, '현재가보다 낮은 가격');
  await h.change('tp-sl-take-profit-trigger-price', '110');
  await h.press('tp-sl-take-profit-ratio-50');
  assert.match(words(h.node('tp-sl-take-profit-warning')), /이미 이 가격에 도달/);
  await h.change('tp-sl-take-profit-trigger-price', '90');
  assert.equal(h.node('tp-sl-take-profit-warning') === undefined, true);
  await h.press('tp-sl-stop-loss-toggle');
  assert.equal(h.node('tp-sl-stop-loss-trigger-price').props.placeholder, '현재가보다 높은 가격');
});

test('주문방식 starts at 시장가 and offers only 시장가, 지정가 and 조건주문; flat 조건주문 is a new-position entry, held 지정가/조건주문 explain why they wait', async t => {
  const methods = (h: any) => ['market', 'limit', 'conditional', 'loc', 'protection'].filter(m => h.node(`order-method-${m}`) !== undefined);
  const flat = futuresHarness({ protectionEnabled: true });
  await flat.start(); t.after(flat.close);
  assert.equal(flat.orderType(), '시장가');
  assert.equal(flat.node('order-type-select').props.accessibilityLabel, '주문방식 시장가');
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
  assert.equal(words(h.node("futures-last-price")), "$102");
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

test("the header keeps the contract, its Last and Mark and the chart; no subtitle, wallet card or 기록 view", async (t) => {
  const h = futuresHarness({ position: true });
  await h.start();
  t.after(h.close);
  const text = h.text();
  assert.equal(/USD 가상 무기한 계약|선물 Last 거래 기준|평가\/청산 기준/.test(text), false);
  assert.equal(/"Last"/.test(text) && /"Mark"/.test(text), true, "minimal Last / Mark names stay");
  assert.equal(words(h.node("futures-last-price")), "$102");
  assert.equal(words(h.node("futures-mark-price")), "$101");
  assert.equal(h.node("futures-chart-toggle") !== undefined, true);
  assert.equal(h.node("futures-wallet") === undefined, true, "the futures wallet card is gone");
  assert.match(words(h.node("futures-available-collateral")), /주문가능 9,995(\.00)? USD/);
  assert.equal(h.node("futures-cross") === undefined, true, "isolated: no Cross card");
  assert.equal(h.node("futures-view-positions") !== undefined && h.node("futures-view-pending") !== undefined, true);
  assert.equal(h.node("futures-view-history") === undefined, true, "records moved to the central 거래 내역");
  assert.equal(h.node("futures-position-A:position") !== undefined, true);
  assert.equal(h.node("futures-position-A:position-protection") !== undefined, true, "손절가/익절가 설정 stays");
});

test("a Cross position keeps its shared-collateral risk card", async (t) => {
  const h = futuresHarness({ position: true, marginMode: "cross" });
  await h.start();
  t.after(h.close);
  assert.equal(h.node("futures-cross") !== undefined, true);
  assert.equal(/청산 여유/.test(h.text()), true);
});

/** Advance the device clock without a new read (the screen re-renders each second). */
async function deviceClockPlus(h: any, t: any, ms: number) {
  const real = Date.now;
  Date.now = () => real() + ms;
  t.after(() => { Date.now = real; });
  await h.update();
}

for (const [label, offset] of [["2 s ahead of", -2000], ["1.5 s behind", 1500]] as const)
  test(`a device clock ${label} the server keeps a fresh Mark fresh between reads`, async (t) => {
    const h = futuresHarness({ serverClockOffsetMs: offset, markPrice: "102" });
    await h.start();
    t.after(h.close);
    assert.equal(words(h.node("futures-mark-price")), "$102");
    // 2.1 s without a new read: on the device clock a device 2 s ahead sees this
    // Mark 5.1 s old ("Mark 확인 불가"); on the read's server clock it is 3.1 s.
    await deviceClockPlus(h, t, 2100);
    assert.equal(words(h.node("futures-mark-price")), "$102");
    assert.equal(/Mark가 없거나 오래되었습니다/.test(h.text()), false);
    await h.amount("51");
    assert.equal(h.node("futures-submit").props.state, "enabled");
  });

test("a Mark that is really old, or reads that stop, still show the warning and block Open", async (t) => {
  const stale = futuresHarness({ serverClockOffsetMs: -2000, stale: true });
  await stale.start();
  t.after(stale.close);
  assert.equal(words(stale.node("futures-mark-price")), "Mark 확인 불가");
  assert.equal(/Mark가 없거나 오래되었습니다/.test(stale.text()), true);
  await stale.amount("51");
  assert.equal(stale.node("futures-submit").props.state, "disabled");

  const h = futuresHarness({ serverClockOffsetMs: -2000, markPrice: "102" });
  await h.start();
  t.after(h.close);
  await h.amount("51");
  assert.equal(h.node("futures-submit").props.state, "enabled");
  // 4.5 s without a read: the Mark is 5.5 s old on the server clock.
  const real = Date.now;
  Date.now = () => real() + 4500;
  t.after(() => { Date.now = real; });
  await h.update();
  assert.equal(words(h.node("futures-mark-price")), "Mark 확인 불가");
  assert.equal(/Mark가 없거나 오래되었습니다/.test(h.text()), true);
  assert.equal(h.node("futures-submit").props.state, "disabled");
  // The next read recovers it.
  Date.now = real;
  await h.client.refetchQueries();
  await h.flush();
  assert.equal(words(h.node("futures-mark-price")), "$102");
  assert.equal(/Mark가 없거나 오래되었습니다/.test(h.text()), false);
});

test("the 선물 지갑 준비 guide step points at 주문가능 now that the wallet card is gone", async (t) => {
  const guide = createRequire(import.meta.url)("../../features/quest/questGuideBridge.ts");
  const { TRADING_GUIDE_STEPS } = createRequire(import.meta.url)("../../features/quest/tradingGuideSteps.ts");
  const h = futuresHarness();
  await h.start();
  t.after(h.close);
  const available = h.node("futures-available-collateral");
  assert.equal(available.parent.props.ref === guide.questGuideTarget("futures-funding"), true);
  const step = (Object.values(TRADING_GUIDE_STEPS).flat() as Array<{ target: string; title: string; body: string }>).find((item) => item.target === "futures-funding")!;
  assert.equal(step.title, "선물 지갑 준비");
  assert.equal(/주문가능 USD/.test(step.body) && /지갑 탭에서 USD를 이체/.test(step.body), true);
});
