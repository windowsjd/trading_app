jest.mock('./binance/binance-order-book.service', () => ({
  BinanceOrderBookService: class {},
}));

import {
  MarketOrderBookSubscriptionService,
  matchesMarketOrderBookTarget,
} from './market-order-book-subscription.service';

it('keeps Binance subscription mapping at the provider boundary and validates book units', async () => {
  const service = new MarketOrderBookSubscriptionService({
    loadTargets: jest
      .fn()
      .mockResolvedValue(
        new Map([
          ['BTCUSDT', { assetId: 'btc', symbol: 'BTCUSDT', baseAsset: 'BTC' }],
        ]),
      ),
  } as never);
  const target = await service.loadTarget('btc');
  expect(target).toEqual({
    assetId: 'btc',
    priceUnit: 'USDT',
    quantityUnit: 'BTC',
    marketLabel: 'BTC / USDT',
  });
  expect(await service.loadTarget('unknown')).toBeNull();
  const book = {
    assetId: 'btc',
    priceUnit: 'USDT',
    quantityUnit: 'BTC',
    marketLabel: 'BTC / USDT',
    asks: [],
    bids: [],
    capturedAt: '2026-09-30T00:00:00.000Z',
    effectiveAt: null,
  };
  expect(matchesMarketOrderBookTarget(book, target!)).toBe(true);
  expect(
    matchesMarketOrderBookTarget({ ...book, quantityUnit: 'ETH' }, target!),
  ).toBe(false);
  expect(
    matchesMarketOrderBookTarget({ ...book, assetId: 'other' }, target!),
  ).toBe(false);
});
