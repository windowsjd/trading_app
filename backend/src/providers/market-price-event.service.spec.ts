import { BinanceRealtimePriceEventBus } from './binance/binance-realtime-price-event-bus.service';
import { KisRealtimePriceEventBus } from './kis/kis-realtime-price-event-bus.service';
import {
  MarketPriceEventService,
  normalizeMarketPriceEvent,
} from './market-price-event.service';

const basePrice = {
  price: '100.00000000',
  currencyCode: 'USD',
  sourceName: 'kis_us_delayed_trade',
  effectiveAt: '2026-09-30T01:00:00.000Z',
  capturedAt: '2026-09-30T01:00:01.000Z',
};

describe('app market price boundary', () => {
  it('forwards KIS and Binance prices without provider transport fields', () => {
    const kis = new KisRealtimePriceEventBus();
    const binance = new BinanceRealtimePriceEventBus();
    const received: unknown[] = [];
    const stop = new MarketPriceEventService(kis, binance).subscribe(
      (event) => {
        received.push(event);
      },
    );
    kis.publish({
      type: 'kis_realtime_price',
      assetId: 'us-1',
      snapshotState: 'created',
      price: {
        ...basePrice,
        kind: 'us_delayed_trade',
        key: 'us:AAPL',
        trId: 'HDFSCNT0',
        providerSymbol: 'AAPL',
        symbol: 'AAPL',
        marketCode: 'NAS',
        updatedAt: '2026-09-30T01:00:01.000Z',
      },
    });
    binance.publish({
      type: 'binance_realtime_price',
      assetId: 'btc-1',
      snapshotState: null,
      price: {
        ...basePrice,
        sourceName: 'binance_spot_ws_ticker',
        key: 'BTCUSDT',
        providerSymbol: 'BTCUSDT',
        streamName: 'btcusdt@ticker',
        changeRate: null,
        bidPrice: '99',
        askPrice: '101',
        updatedAt: '2026-09-30T01:00:01.000Z',
      },
    });
    expect(received).toEqual([
      {
        type: 'market_price',
        assetId: 'us-1',
        price: basePrice,
        delayed: true,
        snapshotState: 'created',
      },
      {
        type: 'market_price',
        assetId: 'btc-1',
        price: { ...basePrice, sourceName: 'binance_spot_ws_ticker' },
        delayed: false,
        snapshotState: null,
        topOfBook: { bidPrice: '99', askPrice: '101' },
      },
    ]);
    stop();
    expect(kis.listenerCount()).toBe(0);
    expect(binance.listenerCount()).toBe(0);
  });

  it('preserves absent capabilities and rejects corrupt prices without inventing data', () => {
    const event = {
      type: 'kis_realtime_price',
      assetId: 'kr-1',
      snapshotState: null,
      price: {
        ...basePrice,
        sourceName: 'kis_krx_realtime_trade',
        bidPrice: null,
      },
    };
    const normalized = normalizeMarketPriceEvent(event);
    expect(normalized).toMatchObject({
      delayed: false,
      price: { ...basePrice, sourceName: 'kis_krx_realtime_trade' },
    });
    expect(normalized).not.toHaveProperty('topOfBook');
    expect(
      normalizeMarketPriceEvent({
        ...event,
        price: { ...event.price, price: '0' },
      }),
    ).toBeNull();
    expect(normalizeMarketPriceEvent({ ...event, assetId: null })).toBeNull();
  });

  it('accepts a new provider-independent event without relying on KIS/Binance fields', () => {
    expect(
      normalizeMarketPriceEvent({
        type: 'market_price',
        assetId: 'stock-2',
        price: { ...basePrice, sourceName: 'future_source' },
        delayed: false,
        snapshotState: null,
        rawPayload: { apiKey: 'never-forward' },
      }),
    ).toEqual({
      type: 'market_price',
      assetId: 'stock-2',
      price: { ...basePrice, sourceName: 'future_source' },
      delayed: false,
      snapshotState: null,
    });
  });
});
