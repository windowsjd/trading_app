import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness, deferred, act } = require('../../../test/inlineTradingHarness.cjs');
// The same module instance the screens load (CommonJS require cache).
const fillEvents = require('../../features/order/fillEvents.ts');

const qty = TEST_IDS.order.quantityInput;
const limitPrice = TEST_IDS.order.limitPriceInput;
const submit = TEST_IDS.order.executeSubmit;
const text = (h: any) => JSON.stringify(h.renderer.toJSON());
const capabilities = (overrides: Record<string, unknown> = {}) => (id: string) => ({
  tradingAccountId: id,
  capabilities: { enabled: true, canCreate: true, canCancel: true, canUseLimit: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20, ...overrides },
  conditionalOrders: [],
  pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null },
});
const locPreview = {
  market: 'KRX', sessionDate: '2026-10-13', sessionOpenAt: '2026-10-13T00:00:00.000Z',
  sessionCloseAt: '2026-10-13T06:30:00.000Z', evidenceDeadlineAt: '2026-10-13T09:30:00.000Z',
  executionPricePolicy: 'final_regular_session_close',
};
function recordEvents(t: any) {
  const events: any[] = [];
  const stop = fillEvents.subscribeOrderFillEvents((event: any) => events.push(event));
  t.after(stop);
  return events;
}
function stock(h: any, accountId = 'general') {
  h.accountId = accountId;
  h.assetId = 'samsung';
  h.assets.samsung.marketStatus = 'open';
  h.assets.samsung.tradable = true;
}

describe('Conditional BUY', () => {
  for (const accountId of ['general', 'season'])
    it(`${accountId} KRX: watch and limit prices stay separate; registration is not a fill`, async (t) => {
      const h = inlineTradingHarness();
      stock(h, accountId);
      h.conditionalList = capabilities()(accountId);
      h.method = 'conditional';
      const events = recordEvents(t);
      await h.mount(); t.after(h.close);
      assert.equal(h.node(submit) === undefined, true, 'the ordinary submit is replaced');
      assert.equal(h.node('conditional-submit').props.state, 'disabled');
      await h.press('conditional-trigger-at_or_below');
      await h.input('conditional-trigger-price', '69000');
      await h.press('conditional-execution-limit');
      await h.input('conditional-limit-price', '68500');
      await h.input('conditional-size', '2');
      assert.match(text(h), /감시 중에는 현금을 예약하지 않아요/);
      await h.press('conditional-submit'); await h.flush();
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].url, `/trading-accounts/${accountId}/conditional-buy-orders`);
      const body = h.requests[0].body;
      assert.deepEqual({ ...body, idempotencyKey: undefined }, {
        assetId: 'samsung', triggerCondition: 'at_or_below', triggerPrice: '69000', executionType: 'limit',
        limitPrice: '68500', quantity: '2', idempotencyKey: undefined,
      });
      assert.match(body.idempotencyKey, /^conditional_buy_[A-Za-z0-9:_-]{8,}$/);
      assert.equal(h.node('conditional-registered') !== undefined, true);
      assert.match(text(h), /조건주문이 등록되었습니다\. 감시 중입니다\./);
      assert.doesNotMatch(text(h), /체결 완료|체결되었습니다/);
      assert.deepEqual(events.map((event) => [event.kind, event.accountId]), [['watch', accountId]]);
      assert.ok(h.invalidations.some((key: any[]) => key[1] === 'conditionalBuyOrders' && key[2] === accountId));
      // The draft is cleared for the next registration.
      assert.equal(h.node('conditional-trigger-price').props.value, '');
    });

  it('crypto Spot: fee-exclusive amount, market execution, no limit price or quantity', async (t) => {
    const h = inlineTradingHarness();
    h.conditionalList = capabilities()('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    assert.match(text(h), /Binance 현물 가격으로만 감시/);
    await h.press('conditional-trigger-at_or_above');
    await h.input('conditional-trigger-price', '800.5');
    await h.input('conditional-size', '25');
    await h.press('conditional-submit'); await h.flush();
    const body = h.requests[0].body;
    assert.equal(body.amount, '25');
    assert.equal('quantity' in body, false);
    assert.equal('limitPrice' in body, false);
    assert.equal(body.executionType, 'market');
    assert.equal(body.triggerCondition, 'at_or_above');
  });

  it('an uncertain create retries the same key and body; an edit is a new intent', async (t) => {
    const h = inlineTradingHarness();
    h.conditionalList = capabilities()('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.press('conditional-trigger-at_or_below');
    await h.input('conditional-trigger-price', '700');
    await h.input('conditional-size', '10');
    h.conditionalFailure = new Error('socket hang up');
    await h.press('conditional-submit'); await h.flush();
    assert.match(text(h), /등록 결과를 확인하지 못했어요/);
    assert.equal(h.node('conditional-registered') === undefined, true);
    assert.equal(h.node('conditional-submit').props.label, '같은 내용으로 다시 확인');
    await h.press('conditional-submit'); await h.flush();
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[1].body, h.requests[0].body, 'same key, same body: the server replays, never a second watch');
    await h.input('conditional-size', '11');
    await h.press('conditional-submit'); await h.flush();
    assert.equal(h.requests.length, 3);
    assert.notEqual(h.requests[2].body.idempotencyKey, h.requests[0].body.idempotencyKey, 'an edit is a new intent');
    assert.equal(h.requests[2].body.quantity ?? h.requests[2].body.amount, '11');
    h.conditionalFailure = null;
    await h.press('conditional-submit'); await h.flush();
    assert.deepEqual(h.requests[3].body, h.requests[2].body);
    assert.equal(h.node('conditional-registered') !== undefined, true);
  });

  it('a definite server refusal shows its reason and drops the key', async (t) => {
    const h = inlineTradingHarness();
    h.conditionalList = capabilities()('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.press('conditional-trigger-at_or_below');
    await h.input('conditional-trigger-price', '700');
    await h.input('conditional-size', '10');
    h.conditionalFailure = { response: { status: 409, data: { error: { code: 'CONDITIONAL_BUY_ALREADY_MET' } } } };
    await h.press('conditional-submit'); await h.flush();
    assert.match(text(h), /이미 감시 조건을 충족해 등록할 수 없습니다/);
    h.conditionalFailure = null;
    await h.press('conditional-submit'); await h.flush();
    assert.notEqual(h.requests[1].body.idempotencyKey, h.requests[0].body.idempotencyKey);
  });

  it('limit execution follows the server: unavailable means the choice is disabled', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.conditionalList = capabilities({ canUseLimit: false })('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    assert.equal(h.node('conditional-execution-limit').props.disabled, true);
    assert.match(text(h), /지정가 발동은 현재 운영 상태에서 이용할 수 없어요/);
  });

  it('server flag off: listed but not selectable, and nothing can be registered', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.conditionalList = capabilities({ enabled: false, canCreate: false })('general');
    h.method = null;
    await h.mount(); t.after(h.close);
    await h.press(TEST_IDS.order.typeSelect);
    assert.equal(h.node('order-method-conditional').props.disabled, true);
    await h.press('order-method-conditional');
    assert.equal(h.node('conditional-buy-form') === undefined, true);
    assert.equal(h.requests.length, 0);
  });
});

describe('KRX LOC BUY', () => {
  const locHarness = (t: any) => {
    const h = inlineTradingHarness();
    stock(h);
    h.orderCapabilities = { tradingAccountId: 'general', limitOrder: { enabled: true, autoExecutionEnabled: false },
      limitOnClose: { enabled: true, markets: ['KRX'], sides: ['buy'], attachedProtection: false } };
    h.protections = { tradingAccountId: 'general', capabilities: { enabled: true, canCreateSpot: true, canUseSpotLimit: true }, groups: [] };
    h.quoteOverride = { limitOnClose: locPreview };
    h.createOverride = { order: { orderId: 'loc-1', side: 'buy', orderType: 'limit', status: 'submitted', quantity: '2.000000',
      limitPrice: '70000.00000000', asset: h.assets.samsung, currencyCode: 'KRW', limitOnClose: { ...locPreview, status: 'pending' } },
      execution: { state: 'submitted' } };
    t.after(() => h.close?.());
    return h;
  };

  it('quote and create both carry limitOnClose; no attached TP/SL; acceptance is not a fill', async (t) => {
    const h = locHarness(t);
    h.method = 'loc';
    const events = recordEvents(t);
    await h.mount();
    assert.equal(h.orderType(), 'LOC 주문');
    assert.equal(h.node('attached-entry-editor') === undefined, true);
    assert.match(text(h), /접수는 체결이 아니에요/);
    await h.input(limitPrice, '70000');
    await h.input(qty, '0.5');
    assert.equal(h.node(submit).props.state, 'disabled');
    assert.match(text(h), /정수 수량/);
    await h.input(qty, '2');
    await h.press(submit); await h.flush();
    assert.equal(h.requests.length, 2);
    for (const request of h.requests) {
      assert.equal(request.body.limitOnClose, true);
      assert.equal(request.body.orderType, 'limit');
      assert.equal(request.body.side, 'buy');
      assert.equal('attachedProtection' in request.body, false);
    }
    assert.equal(h.success().visible, true);
    assert.equal(h.success().payload.order.limitOnClose.status, 'pending');
    // The open LOC order is watched app-wide for its later real fill.
    assert.deepEqual(events.map((event) => [event.kind, event.orderId]), [['order', 'loc-1']]);
  });

  it('an ordinary limit keeps its request byte-identical (no limitOnClose key)', async (t) => {
    const h = locHarness(t);
    h.quoteOverride = undefined;
    h.createOverride = undefined;
    h.method = 'limit';
    await h.mount();
    assert.equal(h.node('attached-entry-editor') !== undefined, true, 'ordinary limit keeps attached TP/SL');
    await h.input(limitPrice, '70000');
    await h.input(qty, '2');
    await h.press(submit); await h.flush();
    for (const request of h.requests) assert.equal('limitOnClose' in request.body, false);
  });

  it('a quote without the LOC session preview never reaches create', async (t) => {
    const h = locHarness(t);
    h.quoteOverride = undefined;
    h.method = 'loc';
    await h.mount();
    await h.input(limitPrice, '70000');
    await h.input(qty, '2');
    await h.press(submit); await h.flush();
    assert.equal(h.requests.length, 1, 'quote only');
    assert.match(text(h), /입력한 주문과 견적이 일치하지 않습니다/);
  });

  it('server LOC off or unknown: listed, never selectable', async (t) => {
    for (const capability of [null, { tradingAccountId: 'general', limitOrder: { enabled: true, autoExecutionEnabled: false },
      limitOnClose: { enabled: false, markets: ['KRX'], sides: ['buy'], attachedProtection: false } }]) {
      const h = locHarness(t);
      h.orderCapabilities = capability;
      h.method = null;
      await h.mount();
      await h.press(TEST_IDS.order.typeSelect);
      assert.equal(h.node('order-method-loc').props.disabled, true);
      await h.press('order-method-loc');
      assert.equal(h.orderType(), '주문방식 선택하기');
      await h.close();
    }
  });
});

describe('order form reset policy', () => {
  it('returning to the screen starts a fresh form; sheets and re-renders keep the draft', async (t) => {
    const h = inlineTradingHarness();
    await h.mount(); t.after(h.close);
    await h.input(qty, '3');
    await h.press(TEST_IDS.order.typeSelect);
    await h.press('order-method-sheet-backdrop');
    await h.update();
    assert.equal(h.node(qty).props.value, '3', 'opening/closing the sheet or re-rendering keeps it');
    h.focused = false;
    await h.update();
    h.focused = true;
    await h.update();
    assert.equal(h.freshForm(), true);
  });
});

describe('fill hand-off from the order form', () => {
  it('an immediate fill shown in the result sheet is not repeated as a banner', async (t) => {
    const h = inlineTradingHarness();
    const events = recordEvents(t);
    h.createOverride = { order: { orderId: 'm-1', side: 'buy', status: 'executed', executedAt: '2026-10-13T01:00:00.000Z', quantity: '0.1', asset: h.assets.bnb },
      execution: { state: 'executed' } };
    await h.mount(); t.after(h.close);
    await h.input(qty, '10');
    await h.press(submit); await h.flush();
    assert.equal(h.success().visible, true);
    assert.deepEqual(events, []);
  });

  it('an immediate fill whose form is gone is handed to the app banner, once', async (t) => {
    const h = inlineTradingHarness();
    const events = recordEvents(t);
    h.createGate = deferred();
    h.createOverride = { order: { orderId: 'm-2', side: 'buy', status: 'executed', executedAt: '2026-10-13T01:00:00.000Z', quantity: '0.1', asset: h.assets.bnb },
      execution: { state: 'executed' } };
    await h.mount(); t.after(h.close);
    await h.input(qty, '10');
    await h.press(submit); await h.flush();
    h.assetId = 'btc';
    await h.update();
    await act(async () => h.createGate.resolve()); await h.flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'filled');
    assert.equal(events[0].accountId, 'general');
    assert.equal(events[0].order.orderId, 'm-2');
  });
});
