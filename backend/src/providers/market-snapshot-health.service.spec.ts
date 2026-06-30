jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';
import { MarketSnapshotHealthService } from './market-snapshot-health.service';
import { PROVIDER_SOURCE_NAMES } from './source-eligibility.policy';

describe('MarketSnapshotHealthService', () => {
  const now = new Date('2026-06-03T00:00:00.000Z');

  it('treats a 120-second old display asset snapshot as available', async () => {
    const prisma = createPrismaMock({
      assets: [
        asset({
          id: 'asset-samsung',
          symbol: '005930',
          assetType: AssetType.domestic_stock,
          market: 'KRX',
          currencyCode: CurrencyCode.KRW,
          priceCurrency: CurrencyCode.KRW,
        }),
      ],
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      priceSnapshot({
        id: 'price-1',
        assetId: 'asset-samsung',
        price: '70000',
        currencyCode: CurrencyCode.KRW,
        sourceName: PROVIDER_SOURCE_NAMES.domesticStockKrx,
        capturedAt: new Date('2026-06-02T23:58:00.000Z'),
      }),
    ]);
    const service = createService(prisma);

    const result = await service.checkActiveAssetCoverage({ now });

    expect(result.status).toBe('pass');
    expect(result.coverage).toMatchObject({
      activeAssets: 1,
      priceAvailable: 1,
      priceUnavailable: 0,
    });
    expect(result.assets[0]).toMatchObject({
      assetId: 'asset-samsung',
      state: 'available',
      freshnessAgeSeconds: 120,
    });
  });

  it('returns fail status and unavailable asset details when active asset has no usable price', async () => {
    const prisma = createPrismaMock({
      assets: [
        asset({
          id: 'asset-btc',
          symbol: 'BTC',
          assetType: AssetType.crypto,
          market: 'BINANCE',
          currencyCode: CurrencyCode.USD,
          priceCurrency: CurrencyCode.USD,
        }),
      ],
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      fxSnapshot({
        id: 'fx-1',
        capturedAt: new Date('2026-06-02T23:59:00.000Z'),
      }),
    ]);
    const service = createService(prisma);

    const result = await service.checkActiveAssetCoverage({ now });

    expect(result.status).toBe('fail');
    expect(result.coverage.priceUnavailable).toBe(1);
    expect(result.unavailableAssets).toEqual([
      expect.objectContaining({
        assetId: 'asset-btc',
        symbol: 'BTC',
        state: 'unavailable',
        reason: 'PROVIDER_MISSING',
      }),
    ]);
  });
});

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  const resolver = {
    resolveProviderTargets: jest.fn().mockResolvedValue({
      targetSource: 'merged',
      activeAssetCount: 1,
      binanceSymbols: ['BTCUSDT'],
      kisDomesticSymbols: ['005930'],
      kisUsSymbols: [],
      unsupportedAssets: [],
    }),
  };

  return new MarketSnapshotHealthService(prisma as never, resolver as never);
}

function createPrismaMock(input: {
  assets: Array<{
    id: string;
    symbol: string;
    assetType: AssetType;
    market: string;
    currencyCode: CurrencyCode;
    priceCurrency: CurrencyCode;
  }>;
}) {
  return {
    asset: {
      findMany: jest.fn().mockResolvedValue(input.assets),
    },
    assetPriceSnapshot: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    fxRateSnapshot: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

function asset(input: {
  id: string;
  symbol: string;
  assetType: AssetType;
  market: string;
  currencyCode: CurrencyCode;
  priceCurrency: CurrencyCode;
}) {
  return input;
}

function priceSnapshot(input: {
  id: string;
  assetId: string;
  price: string;
  currencyCode: CurrencyCode;
  sourceName: string;
  capturedAt: Date;
}) {
  return {
    id: input.id,
    assetId: input.assetId,
    price: new Prisma.Decimal(input.price),
    priceKrw:
      input.currencyCode === CurrencyCode.KRW
        ? new Prisma.Decimal(input.price)
        : null,
    currencyCode: input.currencyCode,
    sourceType: AssetPriceSourceType.provider_api,
    sourceName: input.sourceName,
    effectiveAt: input.capturedAt,
    capturedAt: input.capturedAt,
  };
}

function fxSnapshot(input: { id: string; capturedAt: Date }) {
  return {
    id: input.id,
    rate: new Prisma.Decimal('1400'),
    sourceType: FxRateSourceType.provider_api,
    sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
    effectiveAt: input.capturedAt,
    capturedAt: input.capturedAt,
  };
}
