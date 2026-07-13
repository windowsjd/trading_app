jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    Prisma: { Decimal },
  };
});

import { AssetType } from '../generated/prisma/client';
import type { BinanceFiveMinuteKline } from '../providers/binance/binance-kline.parser';
import type { KisWebSocketTradeTick } from '../providers/kis/kis-websocket.types';
import { readLiveCandleConfig } from './live-candle.config';
import {
  LiveCandleEventNormalizerService,
  LiveCandleEventValidationError,
} from './live-candle-event-normalizer.service';

describe('LiveCandleEventNormalizerService', () => {
  const service = new LiveCandleEventNormalizerService(
    readLiveCandleConfig({}),
  );

  it('normalizes Binance absolute kline values without accumulating volume', () => {
    const eventTime = new Date('2026-07-13T00:04:59.000Z');
    const kline: BinanceFiveMinuteKline = {
      symbol: 'BTCUSDT',
      eventTime,
      openTime: new Date('2026-07-13T00:00:00.000Z'),
      closeTime: new Date('2026-07-13T00:05:00.000Z'),
      open: '100',
      high: '110',
      low: '90',
      close: '105',
      volume: '12',
      quoteVolume: '1260',
      final: true,
      firstTradeId: 1,
      lastTradeId: 2,
      tradeCount: 2,
      eventId: 'event-1',
      sequence: '1:2',
    };
    const event = service.normalizeBinance(
      kline,
      {
        id: 'btc',
        symbol: 'BTC',
        assetType: AssetType.crypto,
        market: 'BINANCE',
        isActive: true,
      },
      new Date('2026-07-13T00:05:00.000Z'),
    );
    expect(event).toMatchObject({
      mode: 'absolute',
      price: '105.00000000',
      tradeQuantity: null,
      amount: null,
      delayed: false,
      absolute: {
        volume: '12.00000000',
        amount: '1260.00000000',
        providerFinal: true,
      },
    });
  });

  it('normalizes a KRX trade to the 09:00 session anchor and leaves amount null', () => {
    const trade = kisTrade({
      kind: 'domestic_krx_realtime_trade',
      symbol: '005930',
      eventTime: new Date('2026-07-13T00:07:01.000Z'),
      receivedAt: new Date('2026-07-13T00:07:02.000Z'),
    });
    const event = service.normalizeKis(trade, {
      id: 'samsung',
      symbol: '005930',
      assetType: AssetType.domestic_stock,
      market: 'KRX',
      isActive: true,
    });
    expect(event).toMatchObject({
      source: 'kis_krx_realtime_trade',
      openTime: new Date('2026-07-13T00:05:00.000Z'),
      closeTime: new Date('2026-07-13T00:10:00.000Z'),
      tradeQuantity: '3.00000000',
      amount: null,
      delayed: false,
      marketSession: 'regular',
    });
  });

  it('uses the US exchange timestamp and labels HDFSCNT0 as delayed', () => {
    const trade = kisTrade({
      kind: 'us_delayed_trade',
      symbol: 'AAPL',
      eventTime: new Date('2026-07-13T14:37:00.000Z'),
      receivedAt: new Date('2026-07-13T14:52:00.000Z'),
    });
    const event = service.normalizeKis(trade, {
      id: 'aapl',
      symbol: 'AAPL',
      assetType: AssetType.us_stock,
      market: 'NAS',
      isActive: true,
    });
    expect(event).toMatchObject({
      source: 'kis_us_delayed_trade',
      delayed: true,
      openTime: new Date('2026-07-13T14:35:00.000Z'),
    });
  });

  it('rejects off-session, future, invalid price, and incompatible asset mappings', () => {
    const offSession = kisTrade({
      eventTime: new Date('2026-07-13T07:00:00.000Z'),
      receivedAt: new Date('2026-07-13T07:00:01.000Z'),
    });
    expect(() =>
      service.normalizeKis(offSession, {
        id: 'samsung',
        symbol: '005930',
        assetType: AssetType.domestic_stock,
        market: 'KRX',
        isActive: true,
      }),
    ).toThrow(/regular session/u);

    const future = kisTrade({
      eventTime: new Date('2026-07-13T00:10:20.000Z'),
      receivedAt: new Date('2026-07-13T00:10:00.000Z'),
    });
    expect(() =>
      service.normalizeKis(future, {
        id: 'samsung',
        symbol: '005930',
        assetType: AssetType.domestic_stock,
        market: 'KRX',
        isActive: true,
      }),
    ).toThrow(LiveCandleEventValidationError);
  });
});

function kisTrade(
  input: Partial<{
    kind: KisWebSocketTradeTick['kind'];
    symbol: string;
    eventTime: Date;
    receivedAt: Date;
  }> = {},
): KisWebSocketTradeTick {
  const eventTime = input.eventTime ?? new Date('2026-07-13T00:01:00.000Z');
  return {
    kind: input.kind ?? 'domestic_krx_realtime_trade',
    trId: input.kind === 'us_delayed_trade' ? 'HDFSCNT0' : 'H0STCNT0',
    providerSymbol: input.symbol ?? '005930',
    symbol: input.symbol ?? '005930',
    price: '70000',
    sourceTimestamp: eventTime,
    exchangeTimestamp: eventTime,
    tradeQuantity: '3',
    absoluteVolume: '100',
    absoluteAmount: null,
    eventId: 'kis-event-1',
    sequence: '100',
    marketSessionCode: null,
    receivedAt: input.receivedAt ?? new Date(eventTime.getTime() + 1_000),
    rawFrame: 'fixture',
    rawFields: {},
    recordIndex: 0,
    marketCode: input.kind === 'us_delayed_trade' ? 'NAS' : 'KRX',
  };
}
