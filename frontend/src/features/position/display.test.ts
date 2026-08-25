import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PositionItemDto, PositionValuationDto } from './api.ts';
import { getPositionDisplay } from './display.ts';

function position(valuation: PositionValuationDto): PositionItemDto {
  return {
    positionId: 'position-kia',
    assetId: 'asset-kia',
    symbol: '000270',
    name: 'Kia',
    market: 'KRX',
    assetType: 'domestic_stock',
    currencyCode: 'KRW',
    quantity: '18.97345900',
    averageCost: '131631.50000000',
    realizedPnl: '0.00000000',
    realizedPnlKrw: '0.00000000',
    valuation,
  };
}

const availableValuation = {
  state: 'available' as const,
  currentPrice: '132000.00000000',
  priceCurrency: 'KRW' as const,
  assetPriceSnapshotId: 'snapshot-1',
  priceEffectiveAt: '2026-08-24T06:30:00.000Z',
  priceCapturedAt: '2026-08-24T06:30:01.000Z',
  priceSource: null,
  positionValue: '2504480.58800000',
  positionValueKrw: '2504480.58800000',
  unrealizedPnl: '6990.71950000',
  unrealizedPnlKrw: '6990.71950000',
  returnRate: '0.27993400',
};

describe('account-scoped position display', () => {
  it('shows available valuation and preserves known holding facts', () => {
    const display = getPositionDisplay(position(availableValuation));

    assert.deepEqual(display, {
      quantity: '18.973459',
      averageCost: '131,632원',
      currentPrice: '132,000원',
      positionValueKrw: '2,504,481원',
      unrealizedPnlKrw: '6,991원',
      returnRate: '0.28%',
      priceStatus: 'current',
      priceNotice: null,
    });
  });

  it('shows cached values with an explicit stale notice', () => {
    const display = getPositionDisplay(
      position({
        ...availableValuation,
        state: 'stale_cache',
        assetPriceSnapshotId: null,
        priceEffectiveAt: null,
        priceCapturedAt: null,
        priceSource: null,
        fxRateSource: null,
        reason: 'LIVE_VALUATION_UNAVAILABLE',
        message: 'internal cached valuation message',
      }),
    );

    assert.equal(display.positionValueKrw, '2,504,481원');
    assert.equal(display.priceStatus, 'stale');
    assert.equal(display.priceNotice, '이전 시세 · 최신 시세 확인 불가');
  });

  it('keeps the row while hiding every price-derived value when unavailable', () => {
    const internalMessage =
      'Asset price snapshot is unavailable for asset f1bda54a-5762-4d16-a5b0-76f56327356c.';
    const display = getPositionDisplay(
      position({
        state: 'unavailable',
        reason: 'ASSET_PRICE_UNAVAILABLE',
        message: internalMessage,
      }),
    );

    assert.equal(display.quantity, '18.973459');
    assert.equal(display.averageCost, '131,632원');
    assert.equal(display.currentPrice, null);
    assert.equal(display.positionValueKrw, '-');
    assert.equal(display.unrealizedPnlKrw, '-');
    assert.equal(display.returnRate, '-');
    assert.equal(display.priceNotice, '현재 시세 조회 불가');
    assert.ok(!JSON.stringify(display).includes(internalMessage));
    assert.ok(!JSON.stringify(display).includes('f1bda54a'));
  });
});
