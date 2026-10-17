import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import { TEST_IDS } from '../../constants/testIds.ts';
import { buyAmountAtRatio } from '../../features/tradingAccount/indicativePreview.ts';
const require = createRequire(import.meta.url);
const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

/**
 * Conditional BUY/SELL forms (2026-10-18): 이상/이하 is decided from the price
 * in session, chosen by the user while a stock market is closed, and refused
 * while the market state is unknown; sizes can be picked as a share of the
 * cash or the holding. Assertions read small strings/booleans only.
 */
const sell = TEST_IDS.assetDetail.sellButton;
/** Only the strings rendered under one host node (never the instance itself). */
const panelText = (node: any): string => node === undefined ? '' : node.findAll((n: any) => typeof n.type === 'string')
  .flatMap((n: any) => [n.props.children].flat().filter((child: unknown) => typeof child === 'string' || typeof child === 'number'))
  .join(' ');
const rendered = (h: any): string => h.renderer.root
  .findAll((node: any) => node.type === 'Text')
  .map((node: any) => [node.props.children].flat().filter((child: unknown) => typeof child === 'string' || typeof child === 'number').join(''))
  .join('\n');
const has = (h: any, pattern: RegExp) => pattern.test(rendered(h));
/** One Text node's own children joined as rendered (`{n}%` is two children). */
const ownText = (node: any): string => node === undefined ? '' : [node.props.children].flat().join('');
const exists = (h: any, id: string) => h.node(id) !== undefined;
const directionChips = (h: any, prefix: string) => h.renderer.root
  .findAll((n: any) => typeof n.type === 'string' && typeof n.props?.testID === 'string' && n.props.testID.startsWith(`${prefix}-at_or`)).length;
const buyList = (id: string, overrides: Record<string, unknown> = {}) => ({
  tradingAccountId: id,
  capabilities: { enabled: true, canCreate: true, canCancel: true, canUseLimit: true, markets: ['KRX', 'CRYPTO_SPOT'],
    offSessionMarkets: ['KRX'], maxLivePerAccount: 20, ...overrides },
  conditionalOrders: [],
  pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null },
});
const sellList = (id: string, condition: Record<string, unknown> = {}) => ({
  tradingAccountId: id,
  capabilities: {
    enabled: true,
    condition: { enabled: true, canCreate: true, canUseLimit: true, offSessionMarkets: ['KRX'], ...condition },
    protection: { enabled: true, canCreate: true, canUseLimit: false },
    canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 30,
  },
  conditionalOrders: [],
  pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null },
});
function stock(h: any, marketStatus: string, accountId = 'general') {
  h.accountId = accountId;
  h.assetId = 'samsung';
  h.assets.samsung.marketStatus = marketStatus;
  h.assets.samsung.tradable = marketStatus === 'open';
}
/** floor6(available × ratio ÷ (price × 1.002)) with the ordinary form's fee headroom. */
const sharesAt = (available: string, price: string, ratio: number) => new Decimal(available).mul(ratio)
  .div(new Decimal(price).mul('1.002')).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(6).replace(/\.?0+$/u, '');

describe('Conditional BUY: direction by market state', () => {
  for (const accountId of ['general', 'season'])
    it(`${accountId} closed KRX: the user chooses 이상/이하 (nothing preselected) and exactly that is sent`, async (t) => {
      const h = inlineTradingHarness();
      stock(h, 'closed', accountId);
      h.conditionalList = buyList(accountId);
      h.conditionalResult = { registeredOffSession: true };
      h.method = 'conditional';
      await h.mount(); t.after(h.close);
      assert.equal(panelText(h.node('conditional-off-session-notice')),
        '정규장 외 시간입니다. 감시 방향을 선택하면 조건주문을 등록할 수 있으며, 다음 정규장부터 감시합니다.');
      assert.equal(directionChips(h, 'conditional-trigger'), 2);
      for (const condition of ['at_or_above', 'at_or_below'])
        assert.equal(h.node(`conditional-trigger-${condition}`).props['aria-checked'], false, condition);
      await h.input('conditional-trigger-price', '72000');
      await h.input('conditional-size', '3');
      assert.equal(h.node('conditional-submit').props.state, 'disabled', 'no direction yet');
      // 70,000 now: "at or below 72,000" would be refused in session as already
      // met, but while closed the user's choice is kept as is.
      await h.press('conditional-trigger-at_or_below');
      assert.equal(h.node('conditional-trigger-at_or_below').props['aria-checked'], true);
      assert.equal(panelText(h.node('conditional-trigger-direction')), '감시 조건 · 72000 KRW 이하 도달 시');
      assert.equal(exists(h, 'conditional-already-met'), false, 'no price comparison while closed');
      assert.equal(h.node('conditional-submit').props.state, 'enabled');
      await h.press('conditional-submit'); await h.flush();
      assert.equal(h.requests.length, 1);
      const body = h.requests[0].body;
      assert.deepEqual([body.triggerCondition, body.triggerPrice, body.executionType, body.quantity],
        ['at_or_below', '72000', 'market', '3']);
      assert.equal(panelText(h.node('conditional-registered-title')), '조건주문이 등록되었습니다. 다음 정규장부터 감시합니다.');
      assert.equal(has(h, /이전 종가로는 발동하지 않아요/), true);
      // The next draft starts without a direction again.
      assert.equal(h.node('conditional-trigger-at_or_below').props['aria-checked'], false);
    });

  it('closed KRX on an older server (no offSessionMarkets): nothing registers, and the cause is shown', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'closed');
    h.conditionalList = buyList('general', { offSessionMarkets: undefined });
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    assert.equal(panelText(h.node('conditional-trigger-direction')), '정규장 외 시간에는 조건주문을 등록할 수 없어요. 정규장 중에 다시 시도해 주세요.');
    assert.equal(directionChips(h, 'conditional-trigger'), 0);
    await h.input('conditional-trigger-price', '72000');
    await h.input('conditional-size', '3');
    assert.equal(h.node('conditional-submit').props.state, 'disabled');
    await h.press('conditional-submit'); await h.flush();
    assert.equal(h.requests.length, 0);
  });

  it('an unknown market state is not a closure: no choice, nothing registers', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'unknown');
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    assert.equal(panelText(h.node('conditional-trigger-direction')),
      '시장 운영 상태를 확인할 수 없어 지금은 조건주문을 등록할 수 없어요. 잠시 후 다시 시도해 주세요.');
    assert.equal(directionChips(h, 'conditional-trigger'), 0);
    assert.equal(exists(h, 'conditional-off-session-notice'), false);
    await h.input('conditional-trigger-price', '72000');
    await h.input('conditional-size', '3');
    assert.equal(h.node('conditional-submit').props.state, 'disabled');
  });

  it('open KRX without a fresh price: a price failure (not a closure) with a re-read of the price', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'open');
    h.assets.samsung.price.priceCapturedAt = new Date(Date.now() - 3_600_000).toISOString();
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.input('conditional-trigger-price', '72000');
    await h.input('conditional-size', '3');
    assert.equal(panelText(h.node('conditional-trigger-direction')), '현재가를 확인할 수 없습니다. 시세가 업데이트된 후 다시 시도해주세요.');
    assert.equal(directionChips(h, 'conditional-trigger'), 0, 'never a manual direction in session');
    assert.equal(h.node('conditional-submit').props.state, 'disabled');
    const reads = h.refetches;
    await h.press('conditional-price-refresh');
    assert.equal(h.refetches, reads + 1);
  });

  it('the market opening mid-draft drops the chosen direction for the price-decided one', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'closed');
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.input('conditional-trigger-price', '72000');
    await h.input('conditional-size', '3');
    await h.press('conditional-trigger-at_or_below');
    // The session opens with a fresh 70,000.
    h.assets.samsung.marketStatus = 'open';
    h.assets.samsung.tradable = true;
    h.assets.samsung.price.priceCapturedAt = new Date().toISOString();
    await h.update(); await h.flush();
    assert.equal(directionChips(h, 'conditional-trigger'), 0);
    assert.equal(panelText(h.node('conditional-trigger-direction')), '감시 조건 · 72000 KRW 이상 도달 시');
    await h.press('conditional-submit'); await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.triggerCondition, 'at_or_above', 'decided from the session price, not the earlier choice');
  });

  for (const [code, copy] of [
    ['CONDITIONAL_PRICE_UNAVAILABLE', '현재가를 확인할 수 없습니다. 시세가 업데이트된 후 다시 시도해주세요.'],
    ['MARKET_CALENDAR_UNAVAILABLE', '시장 운영 상태를 확인할 수 없어 지금은 조건주문을 등록할 수 없어요. 잠시 후 다시 시도해 주세요.'],
  ])
    it(`the server's ${code} is explained in this form's words and re-reads the screen`, async (t) => {
      const h = inlineTradingHarness();
      stock(h, 'open');
      h.conditionalList = buyList('general');
      h.conditionalFailure = { response: { status: 409, data: { error: { code } } } };
      h.method = 'conditional';
      await h.mount(); t.after(h.close);
      await h.input('conditional-trigger-price', '72000');
      await h.input('conditional-size', '3');
      const reads = h.refetches;
      await h.press('conditional-submit'); await h.flush();
      assert.equal(h.requests.length, 1);
      assert.equal(has(h, new RegExp(copy.replace(/[.]/gu, '\\.'))), true);
      assert.equal(has(h, /주식은 정규장 중에 등록해주세요/), false, 'never the old in-session-only rule');
      assert.equal(h.refetches > reads, true);
    });
});

describe('Conditional BUY: ratio picks', () => {
  it('KRX market execution: a share of the cash at the higher of the current and watch price; typing moves the share', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'open');
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    assert.equal(h.node('conditional-ratio-slider').props.disabled, true, 'no watch price yet');
    assert.match(panelText(h.node('conditional-ratio-reason')), /감시가격을 입력하면/);
    // 이하 (69,000 < 70,000): priced at the current 70,000.
    await h.input('conditional-trigger-price', '69000');
    await h.press('conditional-ratio-100');
    assert.equal(h.node('conditional-size').props.value, sharesAt('1000000', '70000', 1));
    assert.equal(ownText(h.node('conditional-ratio-percent')), '100%');
    assert.equal(h.node('conditional-ratio-100').props['aria-pressed'], true);
    await h.press('conditional-ratio-25');
    assert.equal(h.node('conditional-size').props.value, sharesAt('1000000', '70000', 0.25));
    await h.slide('conditional-ratio-slider', 50);
    assert.equal(h.node('conditional-size').props.value, sharesAt('1000000', '70000', 0.5));
    // A typed size reads back as its share; no pick stays selected.
    await h.input('conditional-size', '7');
    assert.equal(ownText(h.node('conditional-ratio-percent')), `${Math.round(7 / Number(sharesAt('1000000', '70000', 1)) * 100)}%`);
    assert.equal(h.node('conditional-ratio-50').props['aria-pressed'], false);
    // 이상 (72,000 > 70,000): priced at the watch price, never more than the cash.
    await h.input('conditional-trigger-price', '72000');
    await h.press('conditional-ratio-100');
    const size = h.node('conditional-size').props.value;
    assert.equal(size, sharesAt('1000000', '72000', 1));
    assert.equal(new Decimal(size).mul('72000').mul('1.001').lte('1000000'), true);
  });

  it('limit execution: whole shares at the limit price', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'open');
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.input('conditional-trigger-price', '69000');
    await h.press('conditional-execution-limit');
    assert.match(panelText(h.node('conditional-ratio-reason')), /발동 시 지정가격을 입력하면/);
    await h.input('conditional-limit-price', '68500');
    await h.press('conditional-ratio-100');
    assert.equal(h.node('conditional-size').props.value, '14');
    await h.press('conditional-ratio-25');
    assert.equal(h.node('conditional-size').props.value, '3');
  });

  it('closed KRX: no current price, so market-execution picks are off while typing stays; a limit price restores them', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'closed');
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.input('conditional-trigger-price', '72000');
    assert.equal(h.node('conditional-ratio-slider').props.disabled, true);
    assert.equal(h.node('conditional-ratio-100').props.disabled, true);
    assert.match(panelText(h.node('conditional-ratio-reason')), /정규장 외 시간에는 현재가가 없어 시장가 발동 수량을 비율로 계산할 수 없어요/);
    await h.press('conditional-ratio-100');
    assert.equal(h.node('conditional-size').props.value, '', 'the last close is never used as a price');
    await h.input('conditional-size', '3');
    assert.equal(h.node('conditional-size').props.value, '3', 'the size can still be typed');
    await h.press('conditional-execution-limit');
    await h.input('conditional-limit-price', '68500');
    await h.press('conditional-ratio-100');
    assert.equal(h.node('conditional-size').props.value, '14');
  });

  it('crypto keeps the fee-exclusive principal amount of the ordinary form', async (t) => {
    const h = inlineTradingHarness();
    h.conditionalList = buyList('general');
    h.usdAvailable = '9000';
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    // 9,000 USD available (balance − reserved, as the server reports it); fee 0.1 %.
    await h.press('conditional-ratio-100');
    assert.equal(h.node('conditional-size').props.value, buyAmountAtRatio('9000', '0.001', 1));
    await h.press('conditional-ratio-50');
    assert.equal(h.node('conditional-size').props.value, buyAmountAtRatio('9000', '0.001', 0.5));
    assert.equal(ownText(h.node('conditional-ratio-percent')), '50%');
  });

  it('no available cash: the picks are off with the reason', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'open');
    h.krwBalance = '0';
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.input('conditional-trigger-price', '69000');
    assert.equal(h.node('conditional-ratio-slider').props.disabled, true);
    assert.equal(panelText(h.node('conditional-ratio-reason')), 'KRW 주문 가능 금액이 없어요.');
  });

  it('a picked size never follows the form to another account', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'open');
    h.conditionalList = buyList('general');
    h.method = 'conditional';
    await h.mount(); t.after(h.close);
    await h.input('conditional-trigger-price', '69000');
    await h.press('conditional-ratio-100');
    assert.notEqual(h.node('conditional-size').props.value, '');
    h.accountId = 'season';
    h.routeAccountId = 'season';
    h.conditionalList = buyList('season');
    await h.update(); await h.flush();
    assert.equal(h.freshForm(), true, 'the new account starts a fresh form');
    await h.selectOrderType('conditional');
    assert.equal(h.node('conditional-size').props.value, '');
    assert.equal(h.node('conditional-trigger-price').props.value, '');
  });
});

describe('SELL condition: direction by market state and holding ratio', () => {
  for (const accountId of ['general', 'season'])
    it(`${accountId} closed KRX: the chosen direction is sent; nothing is reserved`, async (t) => {
      const h = inlineTradingHarness();
      stock(h, 'closed', accountId);
      h.method = null;
      h.positions[accountId] = '10';
      h.sellList = sellList(accountId);
      h.sellResult = { registeredOffSession: true };
      await h.mount(); t.after(h.close);
      await h.press(sell);
      await h.selectOrderType('conditional');
      assert.equal(panelText(h.node('sell-off-session-notice')),
        '정규장 외 시간입니다. 감시 방향을 선택하면 조건주문을 등록할 수 있으며, 다음 정규장부터 감시합니다.');
      await h.input('sell-condition-trigger-price', '65000');
      await h.press('sell-condition-ratio-50');
      assert.equal(h.node('sell-condition-quantity').props.value, '5');
      assert.equal(h.node('sell-intent-submit').props.state, 'disabled', 'no direction yet');
      await h.press('sell-trigger-at_or_below');
      assert.equal(panelText(h.node('sell-trigger-direction')), '감시 조건 · 65000 KRW 이하 도달 시');
      assert.equal(has(h, /감시 중에는 수량을 예약하지 않아요/), true);
      await h.press('sell-intent-submit'); await h.flush();
      assert.equal(h.requests.length, 1);
      const body = h.requests[0].body;
      assert.deepEqual([body.kind, body.triggerCondition, body.triggerPrice, body.quantity], ['condition', 'at_or_below', '65000', '5']);
      assert.equal(has(h, /조건주문 설정이 등록되었습니다\. 다음 정규장부터 감시합니다\./), true);
    });

  it('the holding ratio: 25/50/75/100% of 10 held; whole shares for a limit execution; typing moves the share', async (t) => {
    const h = inlineTradingHarness();
    stock(h, 'open');
    h.method = null;
    h.positions.general = '10';
    h.positionAvailable = { general: '6' };
    h.positionReserved = { general: '4' };
    h.sellList = sellList('general');
    await h.mount(); t.after(h.close);
    await h.press(sell);
    await h.selectOrderType('conditional');
    const picks = [];
    for (const percent of [25, 50, 75, 100]) {
      await h.press(`sell-condition-ratio-${percent}`);
      picks.push(h.node('sell-condition-quantity').props.value);
    }
    // Of the holding, not of the unreserved part: nothing is reserved while watching.
    assert.deepEqual(picks, ['2.5', '5', '7.5', '10']);
    assert.equal(exists(h, 'sell-condition-quantity-notice'), true, 'a firing setting sells at most the unreserved part');
    await h.press('sell-condition-execution-limit');
    await h.press('sell-condition-ratio-25');
    assert.equal(h.node('sell-condition-quantity').props.value, '2');
    await h.input('sell-condition-quantity', '5');
    assert.equal(ownText(h.node('sell-condition-ratio-percent')), '50%');
    assert.equal(h.node('sell-condition-ratio-50').props['aria-pressed'], false, 'a typed size is not a pick');
  });
});
