import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMarketChangeDisplay, getMarketException, getMarketSessionLabel } from './marketPresentation.ts';
import { financial } from '../../theme/financialColors.ts';
import { semantic } from '../../theme/tokens.ts';
import type { MarketAssetItemDto } from './api.ts';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy.ts';

const row: MarketAssetItemDto = {
  id: 'kia', assetType: 'domestic_stock', name: 'Kia', symbol: '000270', market: 'KRX',
  priceCurrency: 'KRW', settlementCurrency: 'KRW', isActive: true,
  marketStatus: 'closed', tradable: false, tradeBlockedReason: 'MARKET_CLOSED',
  price: { state: 'available', currentPrice: '113100', priceCurrency: 'KRW', changeRate: '0.84' },
};

test('closed rows retain the canonical price/change; zero and unavailable remain different', () => {
  assert.deepEqual(getMarketChangeDisplay(row), { text: '+0.84%', color: financial.rise });
  assert.equal(getMarketException(row), null);
  for (const [value, text, color] of [
    ['-3.52', '-3.52%', financial.fall], ['0', '0%', semantic.secondary],
    [null, '-', semantic.secondary], ['', '-', semantic.secondary], ['bad', '-', semantic.secondary],
  ] as const) {
    const item = { ...row, price: { ...row.price!, changeRate: value } };
    assert.deepEqual(getMarketChangeDisplay(item), { text, color });
  }
  assert.equal(getMarketChangeDisplay({ ...row, price: { ...row.price!, state: 'unavailable' } }).text, '-');
  assert.equal(row.price?.currentPrice, '113100');
});

test('routine open/closed copy is absent while actionable exceptions remain', () => {
  assert.equal(getMarketException({ ...row, marketStatus: 'open', tradable: true, tradeBlockedReason: null }), null);
  assert.equal(getMarketException({ ...row, isActive: false }), '비활성 종목');
  assert.equal(getMarketException({ ...row, marketStatus: 'unknown', tradeBlockedReason: 'UNKNOWN' }), '시장 상태 확인 불가');
  assert.equal(getMarketException({ ...row, marketStatus: 'open', tradeBlockedReason: 'PRICE_STALE' }), '시세 지연');
  assert.equal(getMarketException({ ...row, tradeBlockedReason: 'PROVIDER_DOWN' }), '거래 제한');
  assert.equal(getMarketException({ ...row, tradeBlockedReason: 'OPERATOR_RESTRICTION' }), '거래 제한');
  assert.equal(getMarketException({ ...row, price: { ...row.price!, state: 'unavailable' } }), '시세 확인 불가');
});

test('market header uses authoritative consensus, crypto never inherits a stock session', () => {
  const empty = new Map();
  assert.equal(getMarketSessionLabel('domestic_stock', [row], empty), '휴장 · 거래 종료');
  assert.equal(getMarketSessionLabel('domestic_stock', [{ ...row, marketStatus: 'open' }], empty), '정규장 · 거래 중');
  assert.equal(getMarketSessionLabel('domestic_stock', [row, { ...row, id: 'b', marketStatus: 'open' }], empty), '시장 상태 확인 중');
  assert.equal(getMarketSessionLabel('domestic_stock', [{ ...row, marketStatus: 'unknown' }], empty), '시장 상태 확인 불가');
  assert.equal(getMarketSessionLabel('domestic_stock', [], empty), '시장 상태 확인 중');
  assert.equal(getMarketSessionLabel('crypto', [{ ...row, assetType: 'crypto', marketStatus: 'always_open' }], empty), '24시간 거래');
  assert.equal(getMarketSessionLabel('crypto', [{ ...row, assetType: 'crypto', marketStatus: 'unknown' }], empty), '시장 상태 확인 불가');
});

test('session header follows accepted ticker transitions, and rejects a legacy overlay on a closed snapshot', () => {
  const ticker: AssetTickerMessage = { type: 'asset_ticker', assetId: 'kia', marketStatus: 'open', tradable: true,
    marketEvaluatedAt: '2026-10-01T00:00:00Z', priceLocal: '114000', priceKrw: '114000', priceKrwState: 'available' };
  assert.equal(getMarketSessionLabel('domestic_stock', [row], new Map([['kia', ticker]])), '정규장 · 거래 중');
  assert.equal(getMarketSessionLabel('domestic_stock', [row], new Map([['kia', { ...ticker, marketEvaluatedAt: undefined }]])), '휴장 · 거래 종료');
});
