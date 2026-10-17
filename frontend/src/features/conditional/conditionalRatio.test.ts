import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import {
  RATIO_PICKS,
  conditionalBuyRatioPrice,
  conditionalBuySizeAtRatio,
  conditionalSellQuantityAtRatio,
  getConditionalBuyRatioBlock,
  getConditionalSellRatioBlock,
  ratioOfCapacity,
  type ConditionalBuyRatioInput,
} from './conditionalRatio.ts';
import { buyAmountAtRatio } from '../tradingAccount/indicativePreview.ts';

const stockBuy = (patch: Partial<ConditionalBuyRatioInput> = {}): ConditionalBuyRatioInput => ({
  crypto: false, executionType: 'market', available: '1000000', feeRate: '0.001', currentPrice: '70000',
  triggerPrice: '69000', limitPrice: '', offSession: false, currency: 'KRW', ...patch,
});
const sizes = (input: ConditionalBuyRatioInput) => RATIO_PICKS.map((ratio) => conditionalBuySizeAtRatio(input, ratio));

describe('conditional ratio picks (2026-10-18)', () => {
  it('offers the ordinary form\'s 25/50/75/100%', () => {
    assert.deepEqual([...RATIO_PICKS], [0.25, 0.5, 0.75, 1]);
  });

  it('SELL: a share of the holding — 100 held gives 25/50/75/100', () => {
    for (const wholeShares of [true, false])
      assert.deepEqual(RATIO_PICKS.map((ratio) => conditionalSellQuantityAtRatio({ holding: '100', wholeShares }, ratio)), ['25', '50', '75', '100']);
  });

  it('SELL: whole shares for a stock limit execution, 6 decimals otherwise, never rounded up', () => {
    assert.deepEqual(RATIO_PICKS.map((ratio) => conditionalSellQuantityAtRatio({ holding: '10', wholeShares: true }, ratio)), ['2', '5', '7', '10']);
    assert.deepEqual(RATIO_PICKS.map((ratio) => conditionalSellQuantityAtRatio({ holding: '10', wholeShares: false }, ratio)), ['2.5', '5', '7.5', '10']);
    assert.equal(conditionalSellQuantityAtRatio({ holding: '0.12345678', wholeShares: false }, 1), '0.123456');
    assert.equal(conditionalSellQuantityAtRatio({ holding: '10.00000000', wholeShares: true }, 1), '10');
    // Too small for the unit: nothing, so the form says so instead of sending 0.
    assert.equal(conditionalSellQuantityAtRatio({ holding: '1', wholeShares: true }, 0.25), null);
    assert.equal(conditionalSellQuantityAtRatio({ holding: '0.000003', wholeShares: false }, 0.25), null);
  });

  it('SELL: an unknown or empty holding blocks the picks with the reason', () => {
    assert.match(getConditionalSellRatioBlock({ holding: null, wholeShares: false }) ?? '', /보유 수량을 확인하면/);
    assert.equal(getConditionalSellRatioBlock({ holding: '0', wholeShares: false }), '보유 수량이 없어요.');
    assert.equal(getConditionalSellRatioBlock({ holding: '3', wholeShares: true }), null);
    assert.equal(conditionalSellQuantityAtRatio({ holding: null, wholeShares: false }, 1), null);
  });

  it('stock BUY at market: the higher of the current and watch price, fee headroom ≥ 0.2 %, 6 decimals rounded down', () => {
    // 이하: the current price is higher, so it prices the pick.
    assert.equal(conditionalBuyRatioPrice(stockBuy()), '70000');
    // 이상: the watch price is higher.
    assert.equal(conditionalBuyRatioPrice(stockBuy({ triggerPrice: '72000' })), '72000');
    const expected = (price: string, ratio: number) => new Decimal('1000000').mul(ratio)
      .div(new Decimal(price).mul('1.002')).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(6).replace(/\.?0+$/u, '');
    assert.deepEqual(sizes(stockBuy()), RATIO_PICKS.map((ratio) => expected('70000', ratio)));
    assert.deepEqual(sizes(stockBuy({ triggerPrice: '72000' })), RATIO_PICKS.map((ratio) => expected('72000', ratio)));
    // Never above the cash, fee included.
    for (const size of sizes(stockBuy({ triggerPrice: '72000' })))
      assert.equal(new Decimal(size!).mul('72000').mul('1.002').lte('1000000'), true);
    // A real fee above the buffer is used instead.
    assert.equal(conditionalBuySizeAtRatio(stockBuy({ feeRate: '0.01' }), 1),
      new Decimal('1000000').div(new Decimal('70000').mul('1.01')).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(6).replace(/\.?0+$/u, ''));
  });

  it('stock BUY with limit execution: whole shares at the limit price, also while the market is closed', () => {
    const limit = stockBuy({ executionType: 'limit', limitPrice: '68500', currentPrice: null, offSession: true });
    assert.equal(getConditionalBuyRatioBlock(limit), null);
    assert.equal(conditionalBuyRatioPrice(limit), '68500');
    // 1,000,000 / (68,500 × 1.002) = 14.56…
    assert.deepEqual(sizes(limit), ['3', '7', '10', '14']);
    assert.match(getConditionalBuyRatioBlock(stockBuy({ executionType: 'limit', limitPrice: '' })) ?? '', /발동 시 지정가격을 입력하면/);
  });

  it('stock BUY at market without a current price: the pick is off (never the last close) and the size is typed', () => {
    const offSession = getConditionalBuyRatioBlock(stockBuy({ currentPrice: null, offSession: true }));
    assert.match(offSession ?? '', /정규장 외 시간에는 현재가가 없어/);
    const failure = getConditionalBuyRatioBlock(stockBuy({ currentPrice: null }));
    assert.match(failure ?? '', /현재가를 확인할 수 없어/);
    assert.notEqual(offSession, failure);
    assert.equal(conditionalBuySizeAtRatio(stockBuy({ currentPrice: null }), 1), null);
    assert.match(getConditionalBuyRatioBlock(stockBuy({ triggerPrice: '' })) ?? '', /감시가격을 입력하면/);
  });

  it('cash unknown or empty blocks every BUY pick', () => {
    assert.match(getConditionalBuyRatioBlock(stockBuy({ available: null })) ?? '', /주문 가능 금액을 확인하면/);
    assert.equal(getConditionalBuyRatioBlock(stockBuy({ available: '0' })), 'KRW 주문 가능 금액이 없어요.');
    assert.equal(getConditionalBuyRatioBlock(stockBuy({ crypto: true, available: '0', currency: 'USD' })), 'USD 주문 가능 금액이 없어요.');
    // Less than one share at the limit price: nothing to pick.
    assert.equal(conditionalBuySizeAtRatio(stockBuy({ executionType: 'limit', limitPrice: '68500', available: '50000' }), 1), null);
  });

  it('crypto BUY keeps the fee-exclusive principal of the ordinary form', () => {
    const crypto = stockBuy({ crypto: true, available: '9000', feeRate: '0.001', currentPrice: null, triggerPrice: '', currency: 'USD' });
    assert.equal(getConditionalBuyRatioBlock(crypto), null, 'no price is needed for an amount');
    assert.deepEqual(sizes(crypto), RATIO_PICKS.map((ratio) => buyAmountAtRatio('9000', '0.001', ratio)));
    assert.match(getConditionalBuyRatioBlock({ ...crypto, feeRate: null }) ?? '', /수수료 정보를 확인해야/);
  });

  it('reads an entered size back as its share, clamped to 0..1', () => {
    assert.equal(ratioOfCapacity('5', '10'), 0.5);
    assert.equal(ratioOfCapacity('25', '10'), 1);
    assert.equal(ratioOfCapacity('', '10'), 0);
    assert.equal(ratioOfCapacity('abc', '10'), 0);
    assert.equal(ratioOfCapacity('5', null), 0);
  });
});
