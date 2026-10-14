import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { financial } from '../../theme/financialColors.ts';
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
  assert.equal(h.orderType(), method === 'conditional' ? '조건주문' : method === 'protection' ? '손절가/익절가 설정' : method === 'loc' ? 'LOC 주문' : '시장가');
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

describe('손절가/익절가 설정 (independent stop-loss / take-profit, market only)', () => {
  /** A live SELL setting of this account, as the list returns it. */
  const live = (kind: 'stop_loss' | 'take_profit', triggerPrice: string, quantity: string, assetId = 'bnb') => ({
    id: `${kind}-${triggerPrice}`, assetId, kind, state: 'watching', status: 'watching', triggerPrice, quantity,
    triggerCondition: kind === 'stop_loss' ? 'at_or_below' : 'at_or_above', executionType: 'market', limitPrice: null,
  });
  const quantityText = (h: any, id: string) => [h.node(`${id}-quantity`).props.children].flat()
    .filter((part: unknown) => typeof part === 'string').join('');

  it('one titled form: 익절 then 손절, each optional; no execution choice; slider share → fixed market quantity; 확인 in the sell color', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '10';
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    expectText(h, /^손절가\/익절가 설정하기$/m);
    expectNoText(h, /해당 계정의 남은 보유 수량 전체를 보호합니다|발동 시 주문방식|지정가격/);
    const order = h.renderer.root.findAll((n: any) => typeof n.type === 'string' && /^sell-(take-profit|stop-loss)-section$/.test(n.props.testID ?? ''))
      .map((n: any) => n.props.testID);
    assert.deepEqual(order, ['sell-take-profit-section', 'sell-stop-loss-section']);
    expectText(h, /익절가 또는 손절가 중 하나 이상을 선택해주세요/);
    const submitNode = h.node('sell-intent-submit');
    assert.deepEqual([submitNode.props.label, submitNode.props.state, submitNode.props.style.backgroundColor], ['확인', 'disabled', financial.sellAction]);
    // Take-profit only: 20% of 10.
    await h.press('sell-take-profit-toggle');
    assert.equal(h.node('sell-take-profit-execution') === undefined && h.node('sell-take-profit-limit-price') === undefined, true);
    await h.input('sell-take-profit-trigger-price', '900');
    assert.equal(h.node('sell-intent-submit').props.state, 'disabled', 'a share is required');
    expectText(h, /익절 수량 비율을 선택해주세요/);
    await h.slide('sell-take-profit-slider', 20);
    assert.equal(h.node('sell-take-profit-percent').props.children.join(''), '20%');
    assert.match(quantityText(h, 'sell-take-profit'), /주문 수량 2 BNB/);
    assert.equal(h.node('sell-intent-submit').props.state, 'enabled', 'one setting is enough');
    // And a stop-loss on the whole holding: the families are separate (20% + 100%).
    await h.press('sell-stop-loss-toggle');
    await h.input('sell-stop-loss-trigger-price', '700');
    await h.press('sell-stop-loss-ratio-100');
    assert.match(quantityText(h, 'sell-stop-loss'), /주문 수량 10 BNB/);
    await h.press('sell-intent-submit'); await h.flush();
    assert.equal(h.requests.length, 1);
    const body = h.requests[0].body;
    assert.deepEqual({ ...body, idempotencyKey: undefined }, {
      kind: 'protection', assetId: 'bnb',
      takeProfit: { triggerPrice: '900', executionType: 'market', quantity: '2' },
      stopLoss: { triggerPrice: '700', executionType: 'market', quantity: '10' },
      idempotencyKey: undefined,
    });
    assert.match(body.idempotencyKey, /^sell_protection_/);
    expectText(h, /설정이 등록되었습니다\. 감시 중입니다\./);
    expectText(h, /익절가 900 USD 이상이면 시장가 매도 · 수량 2 BNB/);
    assert.equal(h.node('sell-take-profit-trigger-price') === undefined, true, 'the draft is cleared');
  });

  it('only the checked setting is sent; unchecking drops its draft', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '10';
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    await h.press('sell-stop-loss-toggle');
    await h.input('sell-stop-loss-trigger-price', '1');
    await h.press('sell-stop-loss-ratio-50');
    await h.press('sell-stop-loss-toggle');
    assert.equal(h.node('sell-stop-loss-trigger-price') === undefined, true);
    await h.press('sell-take-profit-toggle');
    await h.input('sell-take-profit-trigger-price', '900');
    await h.press('sell-take-profit-ratio-25');
    await h.press('sell-intent-submit'); await h.flush();
    assert.deepEqual(Object.keys(h.requests[0].body).sort(), ['assetId', 'idempotencyKey', 'kind', 'takeProfit']);
    assert.equal(h.requests[0].body.takeProfit.quantity, '2.5');
  });

  it('per family: live settings plus the new share stay within the holding; one price per family; the other family is separate', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '10';
    h.sellList = { ...sellList('general'), conditionalOrders: [live('stop_loss', '700', '6'), live('take_profit', '900', '10'), live('stop_loss', '600', '4', 'btc')] };
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    await h.press('sell-stop-loss-toggle');
    await h.input('sell-stop-loss-trigger-price', '650');
    await h.press('sell-stop-loss-ratio-50');
    expectText(h, /감시 중인 손절 1건 · 합계 6 · 추가 가능 4/);
    expectText(h, /감시 중인 손절 설정과 합치면 보유 수량을 넘어요\. \(감시 중 6 · 추가 가능 4\)/);
    assert.equal(h.node('sell-intent-submit').props.state, 'disabled');
    await h.slide('sell-stop-loss-slider', 40);
    assert.equal(h.node('sell-stop-loss-error') === undefined, true, '4 of 10 fits exactly');
    assert.equal(h.node('sell-intent-submit').props.state, 'enabled');
    await h.input('sell-stop-loss-trigger-price', '700');
    expectText(h, /같은 손절가로 감시 중인 설정이 이미 있어요/);
    assert.equal(h.node('sell-intent-submit').props.state, 'disabled');
    await h.input('sell-stop-loss-trigger-price', '640');
    // Take-profits are already at 100%: none can be added until one is canceled.
    await h.press('sell-take-profit-toggle');
    await h.input('sell-take-profit-trigger-price', '950');
    await h.press('sell-take-profit-ratio-25');
    expectText(h, /감시 중인 익절 설정이 이미 보유 수량 전체를 대상으로 해요/);
    assert.equal(h.node('sell-intent-submit').props.state, 'disabled');
    await h.press('sell-take-profit-toggle');
    await h.press('sell-intent-submit'); await h.flush();
    assert.deepEqual(h.requests[0].body.stopLoss, { triggerPrice: '640', executionType: 'market', quantity: '4' });
  });

  it('quantities: 6-decimal floor, never above the holding; too small a share is explained; KRX may sell a fractional share at market', async (t) => {
    const crypto = inlineTradingHarness();
    crypto.method = null;
    crypto.positions.general = '0.000003';
    crypto.sellList = sellList('general');
    await crypto.mount(); t.after(crypto.close);
    await sellWith(crypto, 'protection');
    await crypto.press('sell-stop-loss-toggle');
    await crypto.input('sell-stop-loss-trigger-price', '700');
    await crypto.press('sell-stop-loss-ratio-25');
    expectText(crypto, /선택한 비율의 수량이 최소 주문 단위\(0\.000001\)보다 적어요/);
    assert.equal(crypto.node('sell-intent-submit').props.state, 'disabled');
    await crypto.press('sell-stop-loss-ratio-50');
    assert.match(quantityText(crypto, 'sell-stop-loss'), /주문 수량 0\.000001 BNB/, '0.0000015 floors to one unit');
    const stockForm = inlineTradingHarness();
    stock(stockForm);
    stockForm.method = null;
    stockForm.positions.general = '7';
    stockForm.sellList = sellList('general');
    await stockForm.mount(); t.after(stockForm.close);
    await sellWith(stockForm, 'protection');
    await stockForm.press('sell-take-profit-toggle');
    await stockForm.input('sell-take-profit-trigger-price', '80000');
    await stockForm.press('sell-take-profit-ratio-50');
    assert.match(quantityText(stockForm, 'sell-take-profit'), /주문 수량 3\.5 주/);
    await stockForm.press('sell-intent-submit'); await stockForm.flush();
    assert.equal(stockForm.requests[0].body.takeProfit.quantity, '3.5');
  });

  it('an existing whole-position OCO protection is explained before registration and blocks it; a refusal shows its mapped reason', async (t) => {
    const { conditionalFixture } = require('../../../test/conditionalFixtures.cjs');
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '10';
    h.sellList = sellList('general');
    h.protections = conditionalFixture('general', { domain: 'spot', active: true });
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    expectText(h, /기존 TP\/SL\(OCO\) 보호가 있어 함께 설정할 수 없어요\. 아래 대기 목록의 TP\/SL에서 기존 보호를 취소한 뒤 등록해 주세요\./);
    await h.press('sell-take-profit-toggle');
    await h.input('sell-take-profit-trigger-price', '900');
    await h.press('sell-take-profit-ratio-100');
    assert.equal(h.node('sell-intent-submit').props.state, 'disabled');
    h.protections = conditionalFixture('general', { domain: 'spot' });
    await h.update();
    assert.equal(h.node('sell-intent-submit').props.state, 'enabled');
    h.sellFailure = { isAxiosError: true, response: { status: 409, data: { error: { code: 'CONDITIONAL_SELL_TOTAL_EXCEEDS_HOLDING', message: 'raw server text' } } } };
    await h.press('sell-intent-submit'); await h.flush();
    expectText(h, /감시 중인 같은 종류\(익절 또는 손절\) 설정과 합친 수량이 현재 보유 수량을 넘어/);
    expectNoText(h, /raw server text/);
    assert.equal(h.node('sell-intent-submit').props.label, '확인', 'a definite refusal is not retried with the same key');
  });

  it('an uncertain create retries the same key and body; an edit is a new registration', async (t) => {
    const h = inlineTradingHarness();
    h.method = null;
    h.positions.general = '4';
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await sellWith(h, 'protection');
    await h.press('sell-stop-loss-toggle');
    await h.input('sell-stop-loss-trigger-price', '700');
    await h.press('sell-stop-loss-ratio-50');
    h.sellFailure = new Error('socket hang up');
    await h.press('sell-intent-submit'); await h.flush();
    expectText(h, /등록 결과를 확인하지 못했어요/);
    assert.equal(h.node('sell-intent-submit').props.label, '같은 내용으로 다시 확인');
    await h.press('sell-intent-submit'); await h.flush();
    assert.deepEqual(h.requests[1].body, h.requests[0].body);
    await h.press('sell-stop-loss-ratio-25');
    h.sellFailure = null;
    await h.press('sell-intent-submit'); await h.flush();
    assert.notEqual(h.requests[2].body.idempotencyKey, h.requests[0].body.idempotencyKey);
    assert.equal(h.requests[2].body.stopLoss.quantity, '1');
    assert.equal(h.node('sell-intent-registered') !== undefined, true);
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
    await h.press('sell-take-profit-toggle');
    await h.input('sell-take-profit-trigger-price', '900');
    await h.selectOrderType('conditional');
    assert.equal(h.node('sell-condition-trigger-price').props.value, '');
    await h.selectOrderType('protection');
    assert.equal(h.node('sell-take-profit-trigger-price') === undefined, true, 'the TP/SL draft does not carry over');
    await h.press(buy);
    assert.equal(h.orderType(), '시장가');
    await h.press(sell);
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node('sell-protection-form') === undefined, true);
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
    await h.press('sell-stop-loss-ratio-50');
  }

  it('before QUEST 03 review both SELL settings are locked; 시장가 stays open', async (t) => {
    const h = beginner(2);
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.press('order-type-select');
    assert.equal(learningLocked(h, 'market'), false, 'a market sell reduces risk');
    assert.equal(learningLocked(h, 'conditional'), true);
    assert.equal(learningLocked(h, 'protection'), true);
    assert.equal(h.node('order-method-loc') === undefined, true, 'crypto has no LOC');
    for (const method of ['protection', 'conditional']) {
      await h.press(`order-method-${method}`);
      assert.equal(h.orderType(), '시장가', `${method} is not selected`);
    }
    assert.deepEqual(h.alerts.map((alert: any[]) => alert[1]), [
      'TP/SL 설정 퀘스트에서 사용할 수 있어요.',
      '암호화폐 지정가 매수 퀘스트를 완료하면 사용할 수 있어요.',
    ]);
    assert.equal(h.node('sell-stop-loss-toggle') === undefined && h.node('sell-intent-submit') === undefined, true, 'no SELL setting form');
    await h.press('order-method-market');
    assert.equal(h.orderType(), '시장가');
    assert.equal(h.node(submit).props.learningHint ?? null, null);
    assert.equal(h.requests.some((r: any) => r.url.includes('conditional-sell-orders')), false, 'nothing registered');
  });

  it('at the TP/SL step (QUEST 04) a crypto stop-loss registers while 조건주문 stays locked', async (t) => {
    const h = beginner(3);
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.press('order-type-select');
    assert.equal(learningLocked(h, 'protection'), false);
    assert.equal(learningLocked(h, 'conditional'), true);
    await h.press('order-method-protection');
    assert.equal(h.orderType(), '손절가/익절가 설정');
    assert.equal(h.node('sell-intent-submit').props.learningHint ?? null, null);
    await stopLossDraft(h);
    await h.press('sell-intent-submit'); await h.flush();
    assert.equal(h.alerts.length, 0);
    const created = h.requests.filter((r: any) => r.url === '/trading-accounts/beginner-1/conditional-sell-orders');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].body.stopLoss, { triggerPrice: '700', executionType: 'market', quantity: '1' });
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
