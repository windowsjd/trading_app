import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { questProgress } from '../../../test/questFixtures.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');
// The same module instance the screens load (CommonJS require cache).
const fillEvents = require('../../features/order/fillEvents.ts');

const qty = TEST_IDS.order.quantityInput;
const limitPrice = TEST_IDS.order.limitPriceInput;
const submit = TEST_IDS.order.executeSubmit;
const sell = TEST_IDS.assetDetail.sellButton;
const buy = TEST_IDS.assetDetail.buyButton;
/** Each host Text node's own strings joined (children may be split). */
const rendered = (h: any): string => h.renderer.root
  .findAll((node: any) => node.type === 'Text')
  .map((node: any) => [node.props.children].flat().filter((child: unknown) => typeof child === 'string' || typeof child === 'number').join(''))
  .join('\n');
/** Booleans, so a failure never prints the rendered tree. */
const has = (h: any, pattern: RegExp) => pattern.test(rendered(h));
const expectText = (h: any, pattern: RegExp) => assert.equal(has(h, pattern), true, `missing ${pattern.source.slice(0, 60)}`);
const expectNoText = (h: any, pattern: RegExp) => assert.equal(has(h, pattern), false, `unexpected ${pattern.source.slice(0, 60)}`);
const sellList = (id: string, overrides: { condition?: Record<string, unknown>; protection?: Record<string, unknown> } = {}) => ({
  tradingAccountId: id,
  capabilities: {
    enabled: true,
    condition: { enabled: true, canCreate: true, canUseLimit: true, ...overrides.condition },
    protection: { enabled: true, canCreate: true, canUseLimit: true, ...overrides.protection },
    canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 30,
  },
  conditionalOrders: [],
  pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null },
});
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
async function sellWith(h: any, method: string) {
  await h.press(sell);
  await h.selectOrderType(method);
  assert.equal(h.orderType(), method === 'conditional' ? '조건주문' : method === 'protection' ? '손절·익절 설정' : method === 'loc' ? 'LOC 주문' : '시장가');
}

describe('SELL condition (KRX, crypto)', () => {
  for (const accountId of ['general', 'season'])
    it(`${accountId} KRX: watch and limit prices separate; a 10-share setting on 10 held; registration is not a sale`, async (t) => {
      const h = inlineTradingHarness();
      stock(h, accountId);
      h.method = null;
      h.positions[accountId] = '10';
      h.sellList = sellList(accountId);
      const events = recordEvents(t);
      await h.mount(); t.after(h.close);
      await sellWith(h, 'conditional');
      assert.equal(h.node(submit) === undefined, true, 'the ordinary submit is replaced');
      assert.equal(h.node('sell-intent-submit').props.state, 'disabled');
      await h.press('sell-trigger-at_or_below');
      await h.input('sell-condition-trigger-price', '69000');
      await h.press('sell-condition-execution-limit');
      await h.input('sell-condition-limit-price', '68500');
      await h.press('sell-condition-all');
      assert.equal(h.node('sell-condition-quantity').props.value, '10');
      expectText(h, /설정 수량의 합이 보유 수량보다 많아도 돼요/);
      expectText(h, /매도 가능 수량\(보유 − 다른 주문 예약\)을 넘지 않아요/);
      await h.press('sell-intent-submit'); await h.flush();
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].url, `/trading-accounts/${accountId}/conditional-sell-orders`);
      const body = h.requests[0].body;
      assert.deepEqual({ ...body, idempotencyKey: undefined }, {
        kind: 'condition', assetId: 'samsung', triggerCondition: 'at_or_below', triggerPrice: '69000',
        executionType: 'limit', limitPrice: '68500', quantity: '10', idempotencyKey: undefined,
      });
      assert.match(body.idempotencyKey, /^conditional_sell_[A-Za-z0-9:_-]{8,}$/);
      expectText(h, /조건주문 설정이 등록되었습니다\. 감시 중입니다\./);
      expectNoText(h, /체결됐어요|체결 완료/);
      assert.deepEqual(events.map((event) => [event.kind, event.side, event.accountId]), [['watch', 'sell', accountId]]);
      assert.ok(h.invalidations.some((key: any[]) => key[1] === 'conditionalSellOrders' && key[2] === accountId));
      assert.equal(h.node('sell-condition-trigger-price').props.value, '', 'the draft is cleared');
    });

  it('crypto: target above the unreserved part is allowed and explained, above the holding is refused', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '4';
    h.positionAvailable = { general: '1.5' };
    h.positionReserved = { general: '2.5' };
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'conditional');
    expectText(h, /보유 4 · 매도 가능 1\.5 \(다른 주문 예약 2\.5\)/);
    await h.press('sell-trigger-at_or_above');
    await h.input('sell-condition-trigger-price', '800');
    await h.input('sell-condition-quantity', '3');
    assert.equal(h.node('sell-condition-quantity-notice') !== undefined, true);
    expectText(h, /지금 발동하면 매도 가능 수량\(1\.5\)만 매도돼요/);
    assert.equal(h.node('sell-intent-submit').props.state, 'enabled');
    await h.input('sell-condition-quantity', '4.5');
    expectText(h, /보유 수량\(4\)을 넘을 수 없어요/);
    assert.equal(h.node('sell-intent-submit').props.state, 'disabled');
    await h.press('sell-intent-submit');
    assert.equal(h.requests.length, 0);
  });

  it('an uncertain create retries the same key and body; an edit is a new intent', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '4';
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'conditional');
    await h.press('sell-trigger-at_or_below');
    await h.input('sell-condition-trigger-price', '700');
    await h.input('sell-condition-quantity', '2');
    h.sellFailure = new Error('socket hang up');
    await h.press('sell-intent-submit'); await h.flush();
    expectText(h, /등록 결과를 확인하지 못했어요/);
    assert.equal(h.node('sell-intent-submit').props.label, '같은 내용으로 다시 확인');
    await h.press('sell-intent-submit'); await h.flush();
    assert.deepEqual(h.requests[1].body, h.requests[0].body);
    await h.input('sell-condition-quantity', '3');
    h.sellFailure = null;
    await h.press('sell-intent-submit'); await h.flush();
    assert.notEqual(h.requests[2].body.idempotencyKey, h.requests[0].body.idempotencyKey);
    assert.equal(h.node('sell-intent-registered') !== undefined, true);
  });

  it('server gates: SELL flags off keep the methods visible but unusable; a pending submit never doubles', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '4';
    h.sellList = sellList('general', { condition: { enabled: false, canCreate: false }, protection: { enabled: false, canCreate: false } });
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.press('order-type-select');
    for (const method of ['conditional', 'protection']) {
      assert.equal(h.node(`order-method-${method}`).props.disabled, true);
      assert.equal(h.node(`order-method-${method}-badge`).props.children, '이용 불가');
    }
  });
});

describe('independent stop-loss / take-profit', () => {
  it('SL only, or SL and TP with their own quantities (sum above the holding)', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '10';
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    expectText(h, /손절 또는 익절 중 하나 이상을 설정해주세요/);
    expectText(h, /한쪽이 실행돼도 다른 쪽은 취소되지 않고/);
    expectText(h, /TP\/SL\(OCO\) 보호가 있는 종목에는 함께 설정할 수 없어요/);
    await h.press('sell-stop-loss-toggle');
    assert.equal(h.node('sell-stop-loss-toggle').props['aria-checked'], true);
    await h.input('sell-stop-loss-trigger-price', '700');
    await h.input('sell-stop-loss-quantity', '10');
    await h.press('sell-take-profit-toggle');
    await h.input('sell-take-profit-trigger-price', '900');
    await h.press('sell-take-profit-execution-limit');
    await h.input('sell-take-profit-limit-price', '905');
    await h.input('sell-take-profit-quantity', '6');
    await h.press('sell-intent-submit'); await h.flush();
    const body = h.requests[0].body;
    assert.deepEqual({ ...body, idempotencyKey: undefined }, {
      kind: 'protection', assetId: 'bnb',
      stopLoss: { triggerPrice: '700', executionType: 'market', quantity: '10' },
      takeProfit: { triggerPrice: '900', executionType: 'limit', limitPrice: '905', quantity: '6' },
      idempotencyKey: undefined,
    });
    assert.match(body.idempotencyKey, /^sell_protection_/);
    expectText(h, /손절·익절 설정이 등록되었습니다\. 감시 중입니다\./);
  });

  it('only the enabled leg is sent; an unchecked leg drops its draft', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '10';
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    await h.press('sell-take-profit-toggle');
    await h.input('sell-take-profit-trigger-price', '900');
    await h.input('sell-take-profit-quantity', '2');
    await h.press('sell-stop-loss-toggle');
    await h.input('sell-stop-loss-trigger-price', '1');
    await h.press('sell-stop-loss-toggle');
    assert.equal(h.node('sell-stop-loss-trigger-price') === undefined, true);
    await h.press('sell-intent-submit'); await h.flush();
    assert.deepEqual(Object.keys(h.requests[0].body).sort(), ['assetId', 'idempotencyKey', 'kind', 'takeProfit']);
  });

  it('switching method or side starts a fresh form', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '10';
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'conditional');
    await h.input('sell-condition-trigger-price', '700');
    await h.selectOrderType('protection');
    assert.equal(h.node('sell-condition-trigger-price') === undefined, true);
    await h.selectOrderType('conditional');
    assert.equal(h.node('sell-condition-trigger-price').props.value, '');
    await h.input('sell-condition-trigger-price', '700');
    await h.press(buy);
    assert.equal(h.orderType(), '시장가');
    await h.press(sell);
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node('sell-condition-trigger-price') === undefined, true);
  });
});

describe('KRX LOC SELL and available quantity', () => {
  const locCaps = (id: string, sellEnabled = true) => ({
    tradingAccountId: id,
    limitOrder: { enabled: true, autoExecutionEnabled: true },
    limitOnClose: { enabled: false, markets: ['KRX'], sides: ['buy'], attachedProtection: false },
    limitOnCloseSell: { enabled: sellEnabled, markets: ['KRX'] },
  });
  const preview = {
    market: 'KRX', sessionDate: '2026-10-13', sessionOpenAt: '2026-10-13T00:00:00.000Z',
    sessionCloseAt: '2026-10-13T06:30:00.000Z', evidenceDeadlineAt: '2026-10-13T09:30:00.000Z',
    executionPricePolicy: 'final_regular_session_close',
  };

  it('LOC SELL has its own gate: the BUY flag never opens it', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.method = null;
    h.positions.general = '10';
    h.orderCapabilities = { ...locCaps('general', false), limitOnClose: { enabled: true, markets: ['KRX'], sides: ['buy'], attachedProtection: false } };
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.press('order-type-select');
    assert.equal(h.node('order-method-loc').props.disabled, true);
    assert.equal(h.node('order-method-loc-badge').props.children, '이용 불가');
  });

  it('accepts only the unreserved part, says so first, and keeps requested vs accepted', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.method = null;
    h.positions.general = '10';
    h.positionAvailable = { general: '4' };
    h.positionReserved = { general: '6' };
    h.orderCapabilities = locCaps('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'loc');
    expectText(h, /확정 종가가 지정가격 이상이면 그 종가로 매도해요/);
    expectText(h, /보유 10 · 매도 가능 4 \(다른 주문 예약 6\)/);
    await h.input(limitPrice, '70000');
    await h.input(qty, '10');
    assert.equal(h.node('loc-sell-adjust-notice') !== undefined, true);
    expectText(h, /매도 가능 수량\(4\)만 접수돼요/);
    h.quoteOverride = { quantity: '4.000000', limitOnClose: preview,
      quantityAdjustment: { reason: 'available_quantity', requestedQuantity: '10.000000', acceptedQuantity: '4.000000', availableQuantity: '4.000000' } };
    await h.press(submit); await h.flush();
    const [quote, create] = h.requests;
    assert.deepEqual({ side: quote.body.side, quantity: quote.body.quantity, limitOnClose: quote.body.limitOnClose }, { side: 'sell', quantity: '10', limitOnClose: true });
    assert.equal(create.body.quantity, '4.000000', 'the server-accepted quantity');
    assert.equal(create.body.requestedQuantity, '10.000000', 'what was asked stays visible');
    assert.equal(create.body.limitOnClose, true);
  });

  it('nothing unreserved blocks a LOC SELL; a market sell above the unreserved part is refused up front', async (t) => {
    const h = inlineTradingHarness();
    stock(h);
    h.method = null;
    h.positions.general = '10';
    h.positionAvailable = { general: '0' };
    h.positionReserved = { general: '10' };
    h.orderCapabilities = locCaps('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'loc');
    await h.input(limitPrice, '70000');
    await h.input(qty, '1');
    expectText(h, /LOC 매도로 접수할 수 있는 수량이 없습니다/);
    assert.equal(h.node(submit).props.state, 'disabled');
    await h.selectOrderType('market');
    await h.input(qty, '1');
    expectText(h, /매도 가능 수량을 초과했습니다/);
    assert.equal(h.node(submit).props.state, 'disabled');
  });
});

describe('SELL settings and the beginner learning guide', () => {
  /** A beginner (crypto) holding with the server SELL gates open. */
  function beginner(completed: number) {
    const h = inlineTradingHarness();
    h.accounts.push({ id: 'beginner-1', mode: 'beginner', status: 'active', season: null });
    h.accountId = 'beginner-1';
    h.positions['beginner-1'] = '2';
    h.questProgress = questProgress(completed);
    h.sellList = sellList('beginner-1');
    h.method = null;
    return h;
  }
  const learningLocked = (h: any, method: string) =>
    String(h.node(`order-method-${method}`)?.props.accessibilityLabel ?? '').includes('학습 제한');
  async function stopLossDraft(h: any) {
    await h.press('sell-stop-loss-toggle');
    await h.input('sell-stop-loss-trigger-price', '700');
    await h.input('sell-stop-loss-quantity', '1');
  }

  it('before QUEST 06: 조건주문 and 손절·익절 show the lock and explain it instead of opening; 시장가 stays open', async (t) => {
    const h = beginner(3);
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.press('order-type-select');
    assert.equal(learningLocked(h, 'market'), false, 'a market sell reduces risk');
    assert.equal(learningLocked(h, 'conditional'), true);
    assert.equal(learningLocked(h, 'protection'), true);
    assert.equal(h.node('order-method-loc') === undefined, true, 'crypto has no LOC');
    const lockCopy = '암호화폐 지정가 매수 퀘스트를 완료하면 사용할 수 있어요.';
    for (const method of ['protection', 'conditional']) {
      await h.press(`order-method-${method}`);
      assert.equal(h.alerts.at(-1)?.[1], lockCopy, `${method} explains the lock`);
      assert.equal(h.orderType(), '시장가', `${method} is not selected`);
    }
    assert.equal(h.alerts.length, 2);
    assert.equal(h.node('sell-stop-loss-toggle') === undefined && h.node('sell-intent-submit') === undefined, true, 'no SELL setting form');
    // The plain market sell is never held back by the guide.
    await h.press('order-method-market');
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node(submit).props.learningHint ?? null, null);
    assert.equal(h.requests.some((r: any) => r.url.includes('conditional-sell-orders')), false, 'nothing registered');
  });

  it('after QUEST 06 the same stop-loss registers', async (t) => {
    const h = beginner(6);
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    assert.equal(h.node('sell-intent-submit').props.learningHint ?? null, null);
    await stopLossDraft(h);
    await h.press('sell-intent-submit'); await h.flush();
    assert.equal(h.alerts.length, 0);
    const created = h.requests.filter((r: any) => r.url === '/trading-accounts/beginner-1/conditional-sell-orders');
    assert.equal(created.length, 1);
    assert.equal(created[0].body.kind, 'protection');
    assert.equal(created[0].body.stopLoss.quantity, '1');
  });
});
