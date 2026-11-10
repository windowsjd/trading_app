import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXTENDED_HOURS_PRICE_SOURCE,
  canFillLimitInExtendedHours,
  getExtendedHoursNotice,
  getExtendedHoursPriceLabel,
  getExtendedHoursSessionLabel,
  isExtendedHoursPrice,
  readExtendedHoursSession,
} from './extendedHours.ts';
import { getStockMarketStatus } from './tradingHeader.ts';

const extendedPrice = {
  priceSource: { sourceType: 'provider_api', sourceName: EXTENDED_HOURS_PRICE_SOURCE },
  // 2026-11-10 05:42 EST = 19:42 KST.
  priceEffectiveAt: '2026-11-10T10:42:00.000Z',
};
const regularPrice = {
  priceSource: { sourceType: 'provider_api', sourceName: 'tiingo_us_reference_price' },
  priceEffectiveAt: '2026-11-09T20:59:58.000Z',
};

describe('US extended-hours presentation (server session only)', () => {
  it('reads only the two server sessions', () => {
    assert.equal(readExtendedHoursSession('pre_market'), 'pre_market');
    assert.equal(readExtendedHoursSession('after_hours'), 'after_hours');
    for (const value of [null, undefined, 'overnight', 'regular', 1])
      assert.equal(readExtendedHoursSession(value), null);
    assert.equal(getExtendedHoursSessionLabel('pre_market'), '프리마켓');
    assert.equal(getExtendedHoursSessionLabel('after_hours'), '애프터마켓');
  });

  it('names an extended-hours price by its session, never a regular or missing one', () => {
    assert.equal(isExtendedHoursPrice(extendedPrice.priceSource), true);
    assert.equal(getExtendedHoursPriceLabel(extendedPrice, 'pre_market'), '프리마켓');
    assert.equal(getExtendedHoursPriceLabel(extendedPrice, 'after_hours'), '애프터마켓');
    // A stale session field still never calls it 현재가.
    assert.equal(getExtendedHoursPriceLabel(extendedPrice, null), '시간외');
    assert.equal(getExtendedHoursPriceLabel(regularPrice, 'pre_market'), null);
    assert.equal(getExtendedHoursPriceLabel(null, 'pre_market'), null);
  });

  it('explains the price nature and time, or that none arrived yet', () => {
    assert.equal(
      getExtendedHoursNotice(extendedPrice, 'pre_market'),
      '미국 프리마켓 시세 · 19:42 기준(한국시간) · Tiingo 통합 참조가로, 실제 거래소 체결가와 다를 수 있어요',
    );
    assert.equal(
      getExtendedHoursNotice({ ...extendedPrice, priceEffectiveAt: null }, 'after_hours'),
      '미국 애프터마켓 시세 · Tiingo 통합 참조가로, 실제 거래소 체결가와 다를 수 있어요',
    );
    assert.equal(
      getExtendedHoursNotice(regularPrice, 'after_hours'),
      '미국 애프터마켓 · 애프터마켓 시세가 아직 없어 정규장 마지막 시세를 보여줘요',
    );
    // Outside the sessions (or switch off): nothing to add.
    assert.equal(getExtendedHoursNotice(extendedPrice, null), null);
    assert.equal(getExtendedHoursNotice(extendedPrice, undefined), null);
  });

  it('shows the session as the status of a closed market only', () => {
    assert.equal(getStockMarketStatus('closed', 'pre_market'), '프리마켓');
    assert.equal(getStockMarketStatus('closed', 'after_hours'), '애프터마켓');
    assert.equal(getStockMarketStatus('closed', null), '장마감');
    assert.equal(getStockMarketStatus('closed'), '장마감');
    assert.equal(getStockMarketStatus('open', 'pre_market'), '장중');
    assert.equal(getStockMarketStatus('unknown', 'after_hours'), '상태 확인 불가');
  });

  it('promises an extended-hours limit fill only for a listed US stock in a session', () => {
    const base = { assetType: 'us_stock', extendedHoursSession: 'after_hours', extendedHoursMarkets: ['US'] };
    assert.equal(canFillLimitInExtendedHours(base), true);
    assert.equal(canFillLimitInExtendedHours({ ...base, extendedHoursMarkets: [] }), false);
    assert.equal(canFillLimitInExtendedHours({ ...base, extendedHoursMarkets: undefined }), false);
    assert.equal(canFillLimitInExtendedHours({ ...base, extendedHoursSession: null }), false);
    assert.equal(canFillLimitInExtendedHours({ ...base, assetType: 'domestic_stock' }), false);
  });
});
