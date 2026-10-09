import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPositionAssetDisplay } from './assetDisplay.ts';
import { holding } from '../../../test/positionFixture.ts';
import { HoldingsContractError } from '../tradingAccount/holdings.ts';

describe('Home/Wallet holding value and unrealized return', () => {
  it('uses the complete local valuation and canonical return, regardless of quantity/cost/price', () => {
    assert.deepEqual(getPositionAssetDisplay(holding()), {
      name: '삼성전자', quantity: '보유수량 0.12345678 주', value: '1,120,000원', pnl: '+1,000원', returnRate: '+4.82%', performance: '+1,000원 (+4.82%)', direction: 'rise', notice: null,
    });
  });
  for (const assetType of ['us_stock', 'crypto', 'domestic_stock']) {
    it(`${assetType} follows the valuation currency instead of guessing from asset type`, () => {
      const position = holding('usd');
      Object.assign(position, { assetType, currencyCode: 'KRW' });
      Object.assign(position.valuation, { priceCurrency: 'USD', positionValue: '530.25', unrealizedPnl: '-11.6', returnRate: '-2.14' });
      const display = getPositionAssetDisplay(position);
      assert.equal(display.value, '$530.25');
      assert.equal(display.returnRate, '-2.14%');
      assert.equal(display.direction, 'fall');
    });
  }
  it('keeps genuine zero neutral and missing/invalid valuation values unknown', () => {
    const position = holding();
    Object.assign(position.valuation, { returnRate: '0', unrealizedPnl: '0' });
    assert.equal(getPositionAssetDisplay(position).direction, 'neutral');
    assert.equal(getPositionAssetDisplay(position).returnRate, '0%');
    Object.assign(position.valuation, { returnRate: null, positionValue: null, unrealizedPnl: null });
    const display = getPositionAssetDisplay(position);
    assert.equal(display.value, '-');
    assert.equal(display.returnRate, '-');
    assert.equal(display.direction, 'neutral');
  });
  it('shows stale values with a notice; unavailable hides all valuation values and raw errors', () => {
    const position = holding();
    Object.assign(position.valuation, { state: 'stale_cache', message: 'internal diagnostic' });
    assert.equal(getPositionAssetDisplay(position).value, '1,120,000원');
    assert.equal(getPositionAssetDisplay(position).quantity, '보유수량 0.12345678 주');
    assert.match(getPositionAssetDisplay(position).notice!, /이전 시세/);
    position.valuation = { state: 'unavailable', reason: 'ASSET_PRICE_UNAVAILABLE', message: 'internal diagnostic' };
    const display = getPositionAssetDisplay(position);
    assert.equal(display.value, '-');
    assert.equal(display.returnRate, '-');
    assert.equal(display.quantity.startsWith('보유수량 '), true);
    assert.equal(display.direction, 'neutral');
    assert.doesNotMatch(JSON.stringify(display), /internal diagnostic/);
  });

  for (const assetType of ['domestic_stock', 'us_stock', 'crypto'] as const) {
    for (const quantity of ['10.000000', '0.125000', '0.00080500', '0.12345678', '12345678901234567890.1234567']) {
      it(`${assetType} preserves quantity ${quantity} without changing raw position facts`, () => {
        const position = holding('quantity', { quantity, assetType, market: 'BINANCE', symbol: 'BTCUSDT' });
        const original = structuredClone(position);
        const display = getPositionAssetDisplay(position);
        assert.equal(display.quantity.startsWith('보유수량 '), true);
        assert.equal(display.value, '1,120,000원');
        assert.equal(display.returnRate, '+4.82%');
        assert.deepEqual(position, original);
      });
    }
  }
  for (const state of ['available', 'stale_cache', 'unavailable']) {
    it(`${state} does not turn malformed quantities into valid holdings`, () => {
      for (const quantity of ['-1', 'NaN', 'Infinity', '1e-6', '', null, 'invalid']) {
        const position = holding('invalid', { quantity });
        Object.assign(position.valuation, { state });
        assert.throws(() => getPositionAssetDisplay(position), HoldingsContractError);
      }
    });
  }
});
