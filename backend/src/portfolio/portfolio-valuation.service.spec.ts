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
import { PortfolioValuationError } from './portfolio-valuation.policy';
import { PortfolioValuationService } from './portfolio-valuation.service';

describe('PortfolioValuationService source eligibility', () => {
  const valuationAt = new Date('2026-06-03T00:00:00.000Z');

  it('uses fresh provider_api price and USD/KRW when live portfolio valuation opts in', async () => {
    const prisma = createPrismaMock();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-1',
      initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
      cashWallets: [
        {
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
        {
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
      ],
      positions: [
        {
          assetId: 'asset-us',
          quantity: new Prisma.Decimal('2.00000000'),
          averageCost: new Prisma.Decimal('80.00000000'),
          currencyCode: CurrencyCode.USD,
          realizedPnl: new Prisma.Decimal('0.00000000'),
          asset: {
            id: 'asset-us',
            assetType: AssetType.us_stock,
            market: 'NAS',
            currencyCode: CurrencyCode.USD,
          },
        },
      ],
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-us',
        assetId: 'asset-us',
        price: new Prisma.Decimal('110.00000000'),
        currencyCode: CurrencyCode.USD,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_us_delayed_trade',
        effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
        capturedAt: new Date('2026-06-02T23:59:40.000Z'),
        createdAt: new Date('2026-06-02T23:59:41.000Z'),
      },
    ]);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-1',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        rate: new Prisma.Decimal('1500.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
        capturedAt: new Date('2026-06-02T23:59:40.000Z'),
        createdAt: new Date('2026-06-02T23:59:41.000Z'),
        approvedByUserId: null,
      },
    ]);
    const service = new PortfolioValuationService(prisma as never);

    const result = await service.calculateSeasonParticipantValuation(
      'sp-1',
      valuationAt,
      'live_portfolio_valuation',
    );

    expect(result).toMatchObject({
      totalAssetKrw: '330000.00000000',
      assetValueKrw: '330000.00000000',
      usStockValueKrw: '330000.00000000',
      returnRate: '-67.00000000',
      sourceSummary: {
        providerApiUsed: true,
        adminManualUsed: false,
        fallbackUsed: false,
        fallbackReasons: [],
        rejectedProviderReasons: [],
      },
      assetPriceSourceDecisions: [
        {
          assetId: 'asset-us',
          sourceDecision: {
            selectedSourceType: 'provider_api',
            selectedSourceName: 'kis_us_delayed_trade',
            selectedSnapshotId: 'provider-price-us',
          },
        },
      ],
      fxRateSourceDecision: {
        selectedSourceType: 'provider_api',
        selectedSourceName: 'exchange_rate_api',
        selectedSnapshotId: 'provider-fx-1',
      },
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('uses fresh provider_api price and USD/KRW for daily portfolio snapshot valuation', async () => {
    const prisma = createPrismaMock();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-1',
      initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
      cashWallets: [
        {
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
        {
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
      ],
      positions: [
        {
          assetId: 'asset-us',
          quantity: new Prisma.Decimal('2.00000000'),
          averageCost: new Prisma.Decimal('80.00000000'),
          currencyCode: CurrencyCode.USD,
          realizedPnl: new Prisma.Decimal('0.00000000'),
          asset: {
            id: 'asset-us',
            assetType: AssetType.us_stock,
            market: 'NYS',
            currencyCode: CurrencyCode.USD,
          },
        },
      ],
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-us',
        assetId: 'asset-us',
        price: new Prisma.Decimal('110.00000000'),
        currencyCode: CurrencyCode.USD,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_us_delayed_trade',
        effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
        capturedAt: new Date('2026-06-02T23:59:40.000Z'),
        createdAt: new Date('2026-06-02T23:59:41.000Z'),
      },
    ]);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-1',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        rate: new Prisma.Decimal('1500.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
        capturedAt: new Date('2026-06-02T23:59:40.000Z'),
        createdAt: new Date('2026-06-02T23:59:41.000Z'),
        approvedByUserId: null,
      },
    ]);
    const service = new PortfolioValuationService(prisma as never);

    const result = await service.calculateSeasonParticipantValuation(
      'sp-1',
      valuationAt,
      'daily_portfolio_snapshot',
    );

    expect(result).toMatchObject({
      totalAssetKrw: '330000.00000000',
      sourceSummary: {
        providerApiUsed: true,
        adminManualUsed: false,
        fallbackUsed: false,
        fallbackReasons: [],
        rejectedProviderReasons: [],
      },
      assetPriceSourceDecisions: [
        {
          assetId: 'asset-us',
          sourceDecision: {
            selectedSourceType: 'provider_api',
            selectedSourceName: 'kis_us_delayed_trade',
            selectedSnapshotId: 'provider-price-us',
          },
        },
      ],
      fxRateSourceDecision: {
        selectedSourceType: 'provider_api',
        selectedSourceName: 'exchange_rate_api',
        selectedSnapshotId: 'provider-fx-1',
      },
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to admin_manual when daily snapshot provider asset price is stale', async () => {
    const prisma = createPrismaMock();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-1',
      initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
      cashWallets: [
        {
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal('900000.00000000'),
        },
        {
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
      ],
      positions: [
        {
          assetId: 'asset-krx',
          quantity: new Prisma.Decimal('1.00000000'),
          averageCost: new Prisma.Decimal('100.00000000'),
          currencyCode: CurrencyCode.KRW,
          realizedPnl: new Prisma.Decimal('0.00000000'),
          asset: {
            id: 'asset-krx',
            assetType: AssetType.domestic_stock,
            market: 'KRX',
            currencyCode: CurrencyCode.KRW,
          },
        },
      ],
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-stale',
        assetId: 'asset-krx',
        price: new Prisma.Decimal('999.00000000'),
        currencyCode: CurrencyCode.KRW,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_krx_realtime_trade',
        effectiveAt: new Date('2026-06-02T23:58:30.000Z'),
        capturedAt: new Date('2026-06-02T23:58:59.000Z'),
        createdAt: new Date('2026-06-02T23:59:00.000Z'),
      },
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'admin-price-krx',
      assetId: 'asset-krx',
      price: new Prisma.Decimal('120.00000000'),
      currencyCode: CurrencyCode.KRW,
      sourceType: AssetPriceSourceType.admin_manual,
      sourceName: 'manual-price',
      effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
      capturedAt: new Date('2026-06-02T23:59:40.000Z'),
      createdAt: new Date('2026-06-02T23:59:41.000Z'),
    });
    const service = new PortfolioValuationService(prisma as never);

    const result = await service.calculateSeasonParticipantValuation(
      'sp-1',
      valuationAt,
      'daily_portfolio_snapshot',
    );

    expect(result).toMatchObject({
      totalAssetKrw: '900120.00000000',
      sourceSummary: {
        providerApiUsed: false,
        adminManualUsed: true,
        fallbackUsed: true,
        fallbackReasons: ['provider_rejected'],
        rejectedProviderReasons: ['captured_at_stale'],
      },
      assetPriceSourceDecisions: [
        {
          assetId: 'asset-krx',
          sourceDecision: {
            selectedSourceType: 'admin_manual',
            selectedSnapshotId: 'admin-price-krx',
            fallbackReason: 'provider_rejected',
            rejectedProviderReason: 'captured_at_stale',
          },
        },
      ],
    });
    expect(prisma.assetPriceSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assetId: 'asset-krx',
          currencyCode: CurrencyCode.KRW,
          sourceType: AssetPriceSourceType.admin_manual,
          effectiveAt: {
            lte: valuationAt,
          },
          price: {
            gt: 0,
          },
        }),
      }),
    );
  });

  it('falls back to admin_manual when daily snapshot provider USD/KRW is stale', async () => {
    const prisma = createPrismaMock();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-1',
      initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
      cashWallets: [
        {
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal('900000.00000000'),
        },
        {
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal('10.00000000'),
        },
      ],
      positions: [],
    });
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-stale',
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        rate: new Prisma.Decimal('1500.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date('2026-06-02T23:50:00.000Z'),
        capturedAt: new Date('2026-06-02T23:54:59.000Z'),
        createdAt: new Date('2026-06-02T23:55:00.000Z'),
        approvedByUserId: null,
      },
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      id: 'admin-fx-1',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: new Prisma.Decimal('1400.00000000'),
      sourceType: FxRateSourceType.admin_manual,
      sourceName: 'manual-fx',
      effectiveAt: new Date('2026-06-02T23:59:30.000Z'),
      capturedAt: new Date('2026-06-02T23:59:40.000Z'),
      createdAt: new Date('2026-06-02T23:59:41.000Z'),
      approvedByUserId: 'operator-1',
    });
    const service = new PortfolioValuationService(prisma as never);

    const result = await service.calculateSeasonParticipantValuation(
      'sp-1',
      valuationAt,
      'daily_portfolio_snapshot',
    );

    expect(result).toMatchObject({
      totalAssetKrw: '914000.00000000',
      sourceSummary: {
        providerApiUsed: false,
        adminManualUsed: true,
        fallbackUsed: true,
        fallbackReasons: ['provider_rejected'],
        rejectedProviderReasons: ['captured_at_stale'],
      },
      fxRateSourceDecision: {
        selectedSourceType: 'admin_manual',
        selectedSnapshotId: 'admin-fx-1',
        fallbackReason: 'provider_rejected',
        rejectedProviderReason: 'captured_at_stale',
      },
    });
  });

  it('fails daily snapshot valuation when provider and admin_manual sources are unavailable', async () => {
    const prisma = createPrismaMock();
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-1',
      initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
      cashWallets: [
        {
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal('900000.00000000'),
        },
        {
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
      ],
      positions: [
        {
          assetId: 'asset-krx',
          quantity: new Prisma.Decimal('1.00000000'),
          averageCost: new Prisma.Decimal('100.00000000'),
          currencyCode: CurrencyCode.KRW,
          realizedPnl: new Prisma.Decimal('0.00000000'),
          asset: {
            id: 'asset-krx',
            assetType: AssetType.domestic_stock,
            market: 'KRX',
            currencyCode: CurrencyCode.KRW,
          },
        },
      ],
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);
    const service = new PortfolioValuationService(prisma as never);

    await expect(
      service.calculateSeasonParticipantValuation(
        'sp-1',
        valuationAt,
        'daily_portfolio_snapshot',
      ),
    ).rejects.toMatchObject({
      code: 'ASSET_PRICE_UNAVAILABLE',
    } satisfies Partial<PortfolioValuationError>);
  });
});

function createPrismaMock() {
  return {
    seasonParticipant: {
      findUnique: jest.fn(),
    },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    fxRateSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
  };
}
