import type { PositionItemDto } from '../src/features/position/api.ts';

export const holding = (id = 'samsung', overrides = {}): PositionItemDto => ({
  positionId: `position-${id}`, assetId: id, name: '삼성전자', symbol: '005930',
  assetType: 'domestic_stock', market: 'KRX', currencyCode: 'KRW',
  quantity: '0.12345678', averageCost: '987654', realizedPnl: '0', realizedPnlKrw: '0',
  valuation: {
    state: 'available', currentPrice: '80000', priceCurrency: 'KRW',
    positionValue: '1120000', positionValueKrw: '9999999',
    unrealizedPnl: '1000', unrealizedPnlKrw: '1000', returnRate: '4.82',
    assetPriceSnapshotId: 'snapshot', priceEffectiveAt: '', priceCapturedAt: '', priceSource: null,
  },
  ...overrides,
});

