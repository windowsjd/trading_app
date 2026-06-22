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

import { CurrencyCode } from '../generated/prisma/client';
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
    const gateway = new AssetTickerGateway(
      prisma as never,
      jwtService as never,
      configService as never,
      assetsService as never,
    );

    return { assetsService, gateway, prisma };
  };

  const buildTickerMessage = (
    gateway: AssetTickerGateway,
    assetId: string,
  ) =>
    (
      gateway as unknown as {
        buildTickerMessage(assetId: string): Promise<Record<string, unknown>>;
      }
    ).buildTickerMessage(assetId);

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
});
