import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPositionAssetDisplay } from './assetDisplay.ts';
import { holding } from '../../../test/positionFixture.ts';

describe('Home/Wallet holding value and unrealized return', () => {
  it('uses the complete local valuation and canonical return, regardless of quantity/cost/price', () => {
    assert.deepEqual(getPositionAssetDisplay(holding()), {
      name: '삼성전자', value: '1,120,000원', returnRate: '+4.82%', direction: 'rise', notice: null,
    });
  });
  for (const assetType of ['us_stock', 'crypto', 'domestic_stock']) {
    it(`${assetType} follows the valuation currency instead of guessing from asset type`, () => {
      const position = holding('usd');
      Object.assign(position, { assetType, currencyCode: 'KRW' });
      Object.assign(position.valuation, { priceCurrency: 'USD', positionValue: '530.25', returnRate: '-2.14' });
      const display = getPositionAssetDisplay(position);
      assert.equal(display.value, '$530.25');
      assert.equal(display.returnRate, '-2.14%');
      assert.equal(display.direction, 'fall');
    });
  }
  it('keeps genuine zero neutral and missing/invalid valuation values unknown', () => {
    const position = holding();
    Object.assign(position.valuation, { returnRate: '0' });
    assert.equal(getPositionAssetDisplay(position).direction, 'neutral');
    assert.equal(getPositionAssetDisplay(position).returnRate, '0%');
    Object.assign(position.valuation, { returnRate: null, positionValue: null });
    const display = getPositionAssetDisplay(position);
    assert.equal(display.value, '-');
    assert.equal(display.returnRate, '-');
    assert.equal(display.direction, 'neutral');
  });
  it('shows stale values with a notice; unavailable hides all valuation values and raw errors', () => {
    const position = holding();
    Object.assign(position.valuation, { state: 'stale_cache', message: 'internal diagnostic' });
    assert.equal(getPositionAssetDisplay(position).value, '1,120,000원');
    assert.match(getPositionAssetDisplay(position).notice!, /이전 시세/);
    position.valuation = { state: 'unavailable', reason: 'ASSET_PRICE_UNAVAILABLE', message: 'internal diagnostic' };
    const display = getPositionAssetDisplay(position);
    assert.equal(display.value, '-');
    assert.equal(display.returnRate, '-');
    assert.equal(display.direction, 'neutral');
    assert.doesNotMatch(JSON.stringify(display), /internal diagnostic/);
  });
});
