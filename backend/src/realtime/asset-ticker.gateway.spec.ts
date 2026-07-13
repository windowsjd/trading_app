jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: {
    KRW: 'KRW',
    USD: 'USD',
  },
  PrismaClient: class PrismaClient {},
  UserStatus: {
    active: 'active',
  },
}));
jest.mock('../assets/assets.service', () => ({
  AssetsService: class AssetsService {},
}));
jest.mock('../assets/live-candle-overlay.service', () => ({
  LiveCandleOverlayService: class LiveCandleOverlayService {},
}));
jest.mock('./live-candle-pubsub.service', () => ({
  LiveCandlePubSubService: class LiveCandlePubSubService {},
}));

import { CurrencyCode } from '../generated/prisma/client';
import { BinanceRealtimePriceEventBus } from '../providers/binance/binance-realtime-price-event-bus.service';
import { KisRealtimePriceEventBus } from '../providers/kis/kis-realtime-price-event-bus.service';
import { AssetTickerGateway } from './asset-ticker.gateway';

describe('AssetTickerGateway', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-19T03:00:30.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createGateway = (selection: unknown) => {
    const prisma = {
      user: {
        findUnique: jest.fn(),
      },
      asset: {
        findFirst: jest.fn(),
      },
      assetPriceSnapshot: {
        findFirst: jest.fn(),
      },
      fxRateSnapshot: {
        findFirst: jest.fn(),
      },
    };
    const jwtService = {
      verifyAsync: jest.fn(),
    };
    const configService = {
      get: jest.fn(),
    };
    const assetsService = {
      getAssetPriceForTicker: jest.fn().mockResolvedValue(selection),
    };
    const eventBus = new KisRealtimePriceEventBus();
    const binanceEventBus = new BinanceRealtimePriceEventBus();
    const gateway = new AssetTickerGateway(
      prisma as never,
      jwtService as never,
      configService as never,
      assetsService as never,
      eventBus,
      binanceEventBus,
    );

    return { assetsService, eventBus, binanceEventBus, gateway, prisma };
  };

  const buildTickerMessage = (gateway: AssetTickerGateway, assetId: string) =>
    (
      gateway as unknown as {
        buildTickerMessage(assetId: string): Promise<Record<string, unknown>>;
      }
    ).buildTickerMessage(assetId);

  const buildRealtimeTickerMessage = (
    gateway: AssetTickerGateway,
    event: unknown,
  ) =>
    (
      gateway as unknown as {
        buildRealtimeTickerMessage(
          event: unknown,
        ): Promise<Record<string, unknown>>;
      }
    ).buildRealtimeTickerMessage(event);

  it('formats WS ticker from the REST asset price selection policy', async () => {
    const { assetsService, gateway, prisma } = createGateway({
      asset: {
        id: 'asset-aapl',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        assetType: 'us_stock',
        market: 'NAS',
        priceCurrency: CurrencyCode.USD,
      },
      price: {
        state: 'available',
        currentPrice: '100.00000000',
        changeRate: null,
        priceCurrency: CurrencyCode.USD,
        priceKrwState: 'available',
        priceKrw: '140000.00000000',
        assetPriceSnapshotId: 'price-provider-1',
        priceEffectiveAt: '2026-06-19T03:00:00.000Z',
        priceCapturedAt: '2026-06-19T03:00:10.000Z',
        priceSource: {
          sourceType: 'provider_api',
          sourceName: 'kis_us_delayed_trade',
          snapshotId: 'price-provider-1',
          effectiveAt: '2026-06-19T03:00:00.000Z',
          capturedAt: '2026-06-19T03:00:10.000Z',
          fallbackUsed: false,
          fallbackReason: null,
          rejectedProviderReason: null,
          freshnessAgeSeconds: 20,
        },
        fxRateSource: {
          sourceType: 'provider_api',
          sourceName: 'korea_exim_exchange_rate',
          snapshotId: 'fx-provider-1',
          effectiveAt: '2026-06-19T00:00:00.000Z',
          capturedAt: '2026-06-19T03:00:05.000Z',
          fallbackUsed: false,
          fallbackReason: null,
          rejectedProviderReason: null,
          freshnessAgeSeconds: 25,
        },
      },
    });

    const ticker = await buildTickerMessage(gateway, 'asset-aapl');

    expect(assetsService.getAssetPriceForTicker).toHaveBeenCalledWith(
      'asset-aapl',
    );
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expect(ticker).toMatchObject({
      type: 'asset_ticker',
      assetId: 'asset-aapl',
      symbol: 'AAPL',
      priceLocal: '100.00000000',
      priceCurrency: CurrencyCode.USD,
      priceKrw: '140000.00000000',
      priceKrwState: 'available',
      changeRate: null,
      assetPriceSnapshotId: 'price-provider-1',
      priceCapturedAt: '2026-06-19T03:00:10.000Z',
      priceEffectiveAt: '2026-06-19T03:00:00.000Z',
      freshnessAgeSeconds: 20,
      priceSource: {
        sourceName: 'kis_us_delayed_trade',
      },
      fxRateSource: {
        sourceName: 'korea_exim_exchange_rate',
      },
    });
    expect(JSON.stringify(ticker)).not.toContain('rawPayloadJson');
    expect(JSON.stringify(ticker)).not.toContain('access_token');
  });

  it('returns unavailable ticker payloads from the shared price policy', async () => {
    const { gateway } = createGateway({
      asset: {
        id: 'asset-stale',
        symbol: 'STALE',
        name: 'Stale Asset',
        assetType: 'crypto',
        market: 'BINANCE',
        priceCurrency: CurrencyCode.USD,
      },
      price: {
        state: 'unavailable',
        reason: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable for asset asset-stale.',
      },
    });

    const ticker = await buildTickerMessage(gateway, 'asset-stale');

    expect(ticker).toMatchObject({
      type: 'asset_ticker',
      assetId: 'asset-stale',
      symbol: 'STALE',
      priceLocal: null,
      priceCurrency: CurrencyCode.USD,
      priceKrw: null,
      priceKrwState: 'unavailable',
      changeRate: null,
      assetPriceSnapshotId: null,
      priceCapturedAt: null,
      priceEffectiveAt: null,
      freshnessAgeSeconds: null,
      priceSource: null,
      reason: 'ASSET_PRICE_UNAVAILABLE',
    });
    expect(JSON.stringify(ticker)).not.toContain('rawPayloadJson');
  });

  it('can overlay KIS realtime cache values on the existing ticker payload', async () => {
    const { gateway } = createGateway({
      asset: {
        id: 'asset-samsung',
        symbol: '005930',
        name: 'Samsung Electronics',
        assetType: 'domestic_stock',
        market: 'KRX',
        priceCurrency: CurrencyCode.KRW,
      },
      price: {
        state: 'available',
        currentPrice: '70000.00000000',
        changeRate: null,
        priceCurrency: CurrencyCode.KRW,
        priceKrwState: 'available',
        priceKrw: '70000.00000000',
        assetPriceSnapshotId: 'price-provider-1',
        priceEffectiveAt: '2026-06-19T03:00:00.000Z',
        priceCapturedAt: '2026-06-19T03:00:10.000Z',
        priceSource: {
          sourceType: 'provider_api',
          sourceName: 'kis_krx_realtime_trade',
        },
      },
    });

    const ticker = await buildRealtimeTickerMessage(gateway, {
      type: 'kis_realtime_price',
      assetId: 'asset-samsung',
      snapshotState: 'skipped',
      snapshotReason: 'THROTTLED_PROVIDER_SNAPSHOT',
      price: {
        symbol: '005930',
        price: '70123.00000000',
        currencyCode: CurrencyCode.KRW,
        sourceName: 'kis_krx_realtime_trade',
        capturedAt: '2026-06-19T03:00:29.000Z',
        effectiveAt: '2026-06-19T03:00:29.000Z',
      },
    });

    expect(ticker).toMatchObject({
      type: 'asset_ticker',
      assetId: 'asset-samsung',
      realtime: true,
      snapshotState: 'skipped',
      snapshotReason: 'THROTTLED_PROVIDER_SNAPSHOT',
      priceLocal: '70123.00000000',
      priceCurrency: CurrencyCode.KRW,
      priceCapturedAt: '2026-06-19T03:00:29.000Z',
      priceEffectiveAt: '2026-06-19T03:00:29.000Z',
      freshnessAgeSeconds: 1,
      priceSource: {
        sourceType: 'provider_api',
        sourceName: 'kis_krx_realtime_trade',
      },
    });
  });

  it('can overlay Binance realtime cache values on the existing ticker payload', async () => {
    const { gateway } = createGateway({
      asset: {
        id: 'asset-btc',
        symbol: 'BTC',
        name: 'Bitcoin',
        assetType: 'crypto',
        market: 'BINANCE',
        priceCurrency: CurrencyCode.USD,
      },
      price: {
        state: 'available',
        currentPrice: '100000.00000000',
        changeRate: '1.50000000',
        priceCurrency: CurrencyCode.USD,
        priceKrwState: 'available',
        priceKrw: '140000000.00000000',
        assetPriceSnapshotId: 'price-provider-1',
        priceEffectiveAt: '2026-06-19T03:00:00.000Z',
        priceCapturedAt: '2026-06-19T03:00:10.000Z',
        priceSource: {
          sourceType: 'provider_api',
          sourceName: 'binance_spot_ws_ticker',
        },
      },
    });

    const ticker = await buildRealtimeTickerMessage(gateway, {
      type: 'binance_realtime_price',
      assetId: 'asset-btc',
      snapshotState: 'skipped',
      snapshotReason: 'THROTTLED_PROVIDER_SNAPSHOT',
      price: {
        key: 'BTCUSDT',
        providerSymbol: 'BTCUSDT',
        streamName: 'btcusdt@ticker',
        price: '100123.00000000',
        changeRate: '1.75000000',
        bidPrice: '100122.00000000',
        askPrice: '100124.00000000',
        currencyCode: CurrencyCode.USD,
        sourceName: 'binance_spot_ws_ticker',
        capturedAt: '2026-06-19T03:00:29.000Z',
        effectiveAt: '2026-06-19T03:00:28.000Z',
        updatedAt: '2026-06-19T03:00:29.000Z',
      },
    });

    expect(ticker).toMatchObject({
      type: 'asset_ticker',
      assetId: 'asset-btc',
      realtime: true,
      snapshotState: 'skipped',
      snapshotReason: 'THROTTLED_PROVIDER_SNAPSHOT',
      priceLocal: '100123.00000000',
      priceCurrency: CurrencyCode.USD,
      priceCapturedAt: '2026-06-19T03:00:29.000Z',
      priceEffectiveAt: '2026-06-19T03:00:28.000Z',
      freshnessAgeSeconds: 1,
      changeRate: '1.75000000',
      priceSource: {
        sourceType: 'provider_api',
        sourceName: 'binance_spot_ws_ticker',
      },
    });
  });

  it('never labels the KIS US delayed event feed as realtime', async () => {
    const { gateway } = createGateway({
      asset: {
        id: 'asset-aapl',
        symbol: 'AAPL',
        name: 'Apple',
        assetType: 'us_stock',
        market: 'NAS',
        priceCurrency: CurrencyCode.USD,
      },
      price: {
        state: 'available',
        currentPrice: '190.00000000',
        changeRate: null,
        priceCurrency: CurrencyCode.USD,
        priceKrwState: 'unavailable',
        priceKrw: null,
        assetPriceSnapshotId: null,
        priceEffectiveAt: '2026-06-19T03:00:00.000Z',
        priceCapturedAt: '2026-06-19T03:00:10.000Z',
        priceSource: {
          sourceType: 'provider_api',
          sourceName: 'kis_us_delayed_trade',
        },
      },
    });

    const ticker = await buildRealtimeTickerMessage(gateway, {
      type: 'kis_realtime_price',
      assetId: 'asset-aapl',
      snapshotState: null,
      price: {
        symbol: 'AAPL',
        price: '190.12500000',
        currencyCode: CurrencyCode.USD,
        sourceName: 'kis_us_delayed_trade',
        capturedAt: '2026-06-19T03:00:29.000Z',
        effectiveAt: '2026-06-19T02:45:29.000Z',
      },
    });

    expect(ticker).toMatchObject({ realtime: false, delayed: true });
  });
});
