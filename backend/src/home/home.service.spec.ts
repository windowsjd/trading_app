jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

import { HttpException } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import { HomeService } from './home.service';

describe('HomeService', () => {
  const startAt = new Date(Date.now() - 86_400_000);
  const endAt = new Date(Date.now() + 86_400_000);
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');

  const createPrisma = () => {
    const prisma = {
      season: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      seasonParticipant: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      dailyPortfolioSnapshot: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      seasonRanking: {
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      cashWallet: {
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      position: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      order: {
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      assetPriceSnapshot: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      fxRateSnapshot: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      walletTransaction: {
        create: jest.fn(),
      },
      exchangeTransaction: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      fxExecuteRequest: {
        create: jest.fn(),
        update: jest.fn(),
      },
      equitySnapshot: {
        create: jest.fn(),
      },
    };

    return prisma;
  };

  const createValuationService = () => ({
    calculateSeasonParticipantValuation: jest.fn().mockResolvedValue({
      seasonParticipantId: 'participant-1',
      totalAssetKrw: '1200000.00000000',
      returnRate: '20.00000000',
      krwCash: '900000.00000000',
      usdCashKrw: '140000.00000000',
      assetValueKrw: '160000.00000000',
      domesticStockValueKrw: '60000.00000000',
      usStockValueKrw: '70000.00000000',
      cryptoValueKrw: '30000.00000000',
      realizedPnlKrw: '10000.00000000',
      unrealizedPnlKrw: '20000.00000000',
      valuationAt: new Date('2026-05-07T00:02:00.000Z'),
      sourceSummary: {
        providerApiUsed: false,
        adminManualUsed: true,
        fallbackUsed: true,
        fallbackReasons: ['provider_missing'],
        rejectedProviderReasons: [],
      },
      assetPriceSourceDecisions: [],
      fxRateSourceDecision: {
        selectedSourceType: 'admin_manual',
        selectedSourceName: 'manual-fx',
        selectedSnapshotId: 'fx-rate-snapshot-1',
        selectedEffectiveAt: new Date('2026-05-07T00:01:30.000Z'),
        selectedCapturedAt: new Date('2026-05-07T00:01:40.000Z'),
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
        rejectedProviderReason: null,
        freshnessAgeSeconds: null,
      },
    }),
  });

  const createService = () => {
    const prisma = createPrisma();
    const valuationService = createValuationService();
    const service = new HomeService(prisma as never, valuationService as never);

    return { prisma, valuationService, service };
  };

  const activeSeason = {
    id: 'season-1',
    name: 'Season 1',
    status: SeasonStatus.active,
    startAt,
    endAt,
  };
  const settledSeason = {
    ...activeSeason,
    status: SeasonStatus.settled,
  };

  const participant = {
    id: 'participant-1',
    participantStatus: ParticipantStatus.active,
    joinedAt,
    initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
    cashWallets: [
      {
        currencyCode: CurrencyCode.KRW,
        balanceAmount: new Prisma.Decimal('900000.00000000'),
      },
      {
        currencyCode: CurrencyCode.USD,
        balanceAmount: new Prisma.Decimal('100.00000000'),
      },
    ],
    positions: [
      {
        quantity: new Prisma.Decimal('1.00000000'),
      },
      {
        quantity: new Prisma.Decimal('0.00000000'),
      },
    ],
  };

  const mockActiveSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
  };

  const mockSettledSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(settledSeason);
  };

  const settledParticipant = {
    id: 'participant-1',
    participantStatus: ParticipantStatus.finished,
    joinedAt,
    initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
    finalTier: 'gold',
    rewardGrantedAt: null,
  };

  const finalRanking = {
    rank: 12,
    totalAssetKrw: new Prisma.Decimal('11230000.00000000'),
    returnRate: new Prisma.Decimal('12.30000000'),
    maxDrawdown: new Prisma.Decimal('4.00000000'),
    totalFillCount: 7,
    reachedReturnAt: new Date('2026-05-20T00:01:00.000Z'),
    rankingDate: new Date('2026-05-21T00:00:00.000Z'),
    capturedAt: new Date('2026-05-21T00:00:30.000Z'),
  };

  const chartSnapshot = (
    snapshotDate: string,
    totalAssetKrw: string,
    returnRate: string,
  ) => ({
    snapshotDate: new Date(`${snapshotDate}T00:00:00.000Z`),
    totalAssetKrw: new Prisma.Decimal(totalAssetKrw),
    returnRate: new Prisma.Decimal(returnRate),
    capturedAt: new Date(`${snapshotDate}T00:01:00.000Z`),
  });

  const latestSnapshot = {
    snapshotDate: new Date('2026-05-07T00:00:00.000Z'),
    totalAssetKrw: new Prisma.Decimal('1100000.00000000'),
    returnRate: new Prisma.Decimal('10.00000000'),
    krwCash: new Prisma.Decimal('900000.00000000'),
    usdCashKrw: new Prisma.Decimal('140000.00000000'),
    assetValueKrw: new Prisma.Decimal('60000.00000000'),
    realizedPnlKrw: new Prisma.Decimal('10000.00000000'),
    unrealizedPnlKrw: new Prisma.Decimal('20000.00000000'),
    capturedAt: new Date('2026-05-07T00:01:00.000Z'),
  };

  const freshUsdKrwSnapshot = () => ({
    id: 'fx-rate-snapshot-1',
    rate: new Prisma.Decimal('1400.00000000'),
    sourceType: FxRateSourceType.admin_manual,
    sourceName: 'manual-fx',
    effectiveAt: new Date(Date.now() - 1_000),
    capturedAt: new Date(Date.now() - 1_000),
    approvedByUserId: 'operator-1',
  });

  const priceSnapshot = (
    id: string,
    price: string,
    currencyCode = CurrencyCode.KRW,
  ) => ({
    id,
    price: new Prisma.Decimal(price),
    currencyCode,
    sourceType: AssetPriceSourceType.admin_manual,
    sourceName: 'manual-price',
    effectiveAt: new Date('2026-05-07T00:00:00.000Z'),
    capturedAt: new Date('2026-05-07T00:00:10.000Z'),
  });

  const position = (
    id: string,
    assetId: string,
    quantity: string,
    averageCost: string,
    currencyCode = CurrencyCode.KRW,
    assetType = AssetType.domestic_stock,
  ) => ({
    id,
    assetId,
    quantity: new Prisma.Decimal(quantity),
    averageCost: new Prisma.Decimal(averageCost),
    currencyCode,
    asset: {
      symbol: assetId.toUpperCase(),
      name: `Asset ${assetId}`,
      market: currencyCode === CurrencyCode.USD ? 'NASDAQ' : 'KRX',
      assetType,
      currencyCode,
    },
  });

  const expectNoHomeWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.dailyPortfolioSnapshot,
      prisma.seasonRanking,
      prisma.cashWallet,
      prisma.position,
      prisma.order,
      prisma.assetPriceSnapshot,
      prisma.fxRateSnapshot,
      prisma.exchangeTransaction,
    ]) {
      for (const method of [
        'create',
        'update',
        'updateMany',
        'upsert',
        'delete',
        'deleteMany',
      ] as const) {
        if (method in model) {
          expect(model[method]).not.toHaveBeenCalled();
        }
      }
    }

    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
  };

  it('returns active joined home summary from live valuation even when a daily snapshot exists', async () => {
    const { prisma, valuationService, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      latestSnapshot,
    ]);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(response.data.mode).toBe('active_joined');
    expect(response.data.summary).toMatchObject({
      state: 'available',
      valuationSource: 'live_valuation',
      valuationAt: '2026-05-07T00:02:00.000Z',
      totalAssetKrw: '1200000.00000000',
      returnRate: '20.00000000',
    });
    expect(response.data.ranking).toMatchObject({
      state: 'unavailable',
      rankingSource: 'unavailable',
    });
    expect(response.data.walletSummary).toMatchObject({
      state: 'available',
      positionsCount: 2,
      openPositionsCount: 1,
    });
    expect(response.data.allocation).toMatchObject({
      state: 'available',
      allocationSource: 'live_valuation',
      totalAssetKrw: '1200000.00000000',
      items: [
        {
          category: 'krw_cash',
          amountKrw: '900000.00000000',
          percentage: '75.00000000',
        },
        {
          category: 'usd_cash',
          amountKrw: '140000.00000000',
        },
        {
          category: 'domestic_stock',
          amountKrw: '60000.00000000',
        },
        {
          category: 'us_stock',
          amountKrw: '70000.00000000',
        },
        {
          category: 'crypto',
          amountKrw: '30000.00000000',
        },
      ],
    });
    expect(response.data.topPositions).toMatchObject({
      state: 'available',
      items: [],
    });
    expect(response.data.equityChart).toMatchObject({
      state: 'available',
      chartSource: 'daily_portfolio_snapshots',
      items: [
        {
          snapshotDate: '2026-05-07',
          totalAssetKrw: '1100000.00000000',
          returnRate: '10.00000000',
        },
      ],
    });
    expect(
      valuationService.calculateSeasonParticipantValuation,
    ).toHaveBeenCalledTimes(1);
    expectNoHomeWrites(prisma);
  });

  it('uses live valuation when no daily snapshot exists', async () => {
    const { prisma, valuationService, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(null);
    valuationService.calculateSeasonParticipantValuation.mockResolvedValueOnce({
      seasonParticipantId: 'participant-1',
      totalAssetKrw: '1200000.00000000',
      returnRate: '20.00000000',
      krwCash: '900000.00000000',
      usdCashKrw: '140000.00000000',
      assetValueKrw: '160000.00000000',
      domesticStockValueKrw: '60000.00000000',
      usStockValueKrw: '70000.00000000',
      cryptoValueKrw: '30000.00000000',
      realizedPnlKrw: '10000.00000000',
      unrealizedPnlKrw: '20000.00000000',
      valuationAt: new Date('2026-05-07T00:02:00.000Z'),
      sourceSummary: {
        providerApiUsed: true,
        adminManualUsed: true,
        fallbackUsed: true,
        fallbackReasons: ['provider_rejected'],
        rejectedProviderReasons: ['captured_at_stale'],
      },
      assetPriceSourceDecisions: [],
      fxRateSourceDecision: {
        selectedSourceType: 'admin_manual',
        selectedSourceName: 'manual-fx',
        selectedSnapshotId: 'fx-rate-snapshot-1',
        selectedEffectiveAt: new Date('2026-05-07T00:01:30.000Z'),
        selectedCapturedAt: new Date('2026-05-07T00:01:40.000Z'),
        fallbackUsed: true,
        fallbackReason: 'provider_rejected',
        rejectedProviderReason: 'captured_at_stale',
        freshnessAgeSeconds: 301,
      },
    });
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rank: 3,
      rankType: SeasonRankingType.daily,
      rankingDate: new Date('2026-05-07T00:00:00.000Z'),
      totalAssetKrw: new Prisma.Decimal('1200000.00000000'),
      returnRate: new Prisma.Decimal('20.00000000'),
      maxDrawdown: new Prisma.Decimal('1.50000000'),
      totalFillCount: 3,
      reachedReturnAt: new Date('2026-05-07T00:03:00.000Z'),
      capturedAt: new Date('2026-05-07T00:03:00.000Z'),
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(10);

    const response = await service.getHome('user-1');

    expect(response.data.summary).toMatchObject({
      state: 'available',
      valuationSource: 'live_valuation',
      valuationAt: '2026-05-07T00:02:00.000Z',
      totalAssetKrw: '1200000.00000000',
      sourceSummary: {
        providerApiUsed: true,
        fallbackUsed: true,
        rejectedProviderReasons: ['captured_at_stale'],
      },
      fxRateSource: {
        sourceType: 'admin_manual',
        sourceName: 'manual-fx',
        snapshotId: 'fx-rate-snapshot-1',
        fallbackUsed: true,
        fallbackReason: 'provider_rejected',
        rejectedProviderReason: 'captured_at_stale',
      },
    });
    expect(response.data.ranking).toMatchObject({
      state: 'available',
      rankingSource: 'season_rankings',
      currentRank: 3,
      totalParticipants: 10,
      rankingDate: '2026-05-07',
      maxDrawdown: '1.50000000',
      totalFillCount: 3,
      reachedReturnAt: '2026-05-07T00:03:00.000Z',
    });
    expect(response.data.allocation).toMatchObject({
      state: 'available',
      totalAssetKrw: '1200000.00000000',
      sourceSummary: {
        providerApiUsed: true,
        fallbackUsed: true,
      },
    });
    expect(
      valuationService.calculateSeasonParticipantValuation,
    ).toHaveBeenCalledWith(
      'participant-1',
      expect.any(Date),
      'home_live_valuation',
    );
    expect(
      valuationService.calculateSeasonParticipantValuation,
    ).toHaveBeenCalledTimes(1);
    expectNoHomeWrites(prisma);
  });

  it('returns valuation unavailable without fake summary values', async () => {
    const { prisma, valuationService, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(null);
    valuationService.calculateSeasonParticipantValuation.mockRejectedValueOnce(
      new PortfolioValuationError(
        'ASSET_PRICE_UNAVAILABLE',
        'Asset price snapshot is unavailable.',
      ),
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(response.data.summary).toMatchObject({
      state: 'unavailable',
      reason: 'ASSET_PRICE_UNAVAILABLE',
      valuationSource: 'unavailable',
    });
    expect(response.data.summary).not.toHaveProperty('totalAssetKrw');
    expect(response.data.allocation).toMatchObject({
      state: 'unavailable',
      reason: 'ASSET_PRICE_UNAVAILABLE',
    });
    expect(response.data.sectionErrors).toEqual(
      expect.arrayContaining([
        {
          section: 'summary',
          code: 'ASSET_PRICE_UNAVAILABLE',
          message: 'Asset price snapshot is unavailable.',
        },
        {
          section: 'allocation',
          code: 'ASSET_PRICE_UNAVAILABLE',
          message: 'Asset price snapshot is unavailable.',
        },
      ]),
    );
    expect(response.data.sectionErrors).toHaveLength(2);
    expectNoHomeWrites(prisma);
  });

  it('converts USD positions with fresh approved admin_manual USD/KRW and returns top positions sorted and limited', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(
      latestSnapshot,
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.position.findMany.mockResolvedValueOnce([
      position('position-zero', 'asset-zero', '0.00000000', '100.00000000'),
      position('position-small', 'asset-small', '1.00000000', '100.00000000'),
      position('position-large', 'asset-large', '5.00000000', '90.00000000'),
      position(
        'position-usd',
        'asset-usd',
        '2.00000000',
        '80.00000000',
        CurrencyCode.USD,
        AssetType.us_stock,
      ),
      position('position-mid', 'asset-mid', '3.00000000', '100.00000000'),
      position(
        'position-crypto',
        'asset-crypto',
        '1.00000000',
        '40.00000000',
        CurrencyCode.USD,
        AssetType.crypto,
      ),
      position('position-fifth', 'asset-fifth', '4.00000000', '100.00000000'),
      position('position-sixth', 'asset-sixth', '2.00000000', '100.00000000'),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockImplementation((args) => {
      const assetId = args.where.assetId;
      const prices: Record<string, ReturnType<typeof priceSnapshot>> = {
        'asset-small': priceSnapshot(
          'price-small',
          '100.00000000',
          CurrencyCode.KRW,
        ),
        'asset-large': priceSnapshot(
          'price-large',
          '100.00000000',
          CurrencyCode.KRW,
        ),
        'asset-usd': priceSnapshot(
          'price-usd',
          '100.00000000',
          CurrencyCode.USD,
        ),
        'asset-mid': priceSnapshot(
          'price-mid',
          '100.00000000',
          CurrencyCode.KRW,
        ),
        'asset-crypto': priceSnapshot(
          'price-crypto',
          '50.00000000',
          CurrencyCode.USD,
        ),
        'asset-fifth': priceSnapshot(
          'price-fifth',
          '100.00000000',
          CurrencyCode.KRW,
        ),
        'asset-sixth': priceSnapshot(
          'price-sixth',
          '100.00000000',
          CurrencyCode.KRW,
        ),
      };

      return Promise.resolve(prices[assetId] ?? null);
    });

    const response = await service.getHome('user-1');

    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'participant-1',
          quantity: {
            gt: 0,
          },
        },
      }),
    );
    expect(response.data.topPositions).toMatchObject({
      state: 'available',
      limit: 5,
      items: [
        {
          assetId: 'asset-usd',
          assetType: AssetType.us_stock,
          currencyCode: CurrencyCode.USD,
          positionValueKrw: '280000.00000000',
          returnRate: '25.00000000',
        },
        {
          assetId: 'asset-crypto',
          assetType: AssetType.crypto,
          currencyCode: CurrencyCode.USD,
          positionValueKrw: '70000.00000000',
        },
        {
          assetId: 'asset-large',
          positionValueKrw: '500.00000000',
        },
        {
          assetId: 'asset-fifth',
          positionValueKrw: '400.00000000',
        },
        {
          assetId: 'asset-mid',
          positionValueKrw: '300.00000000',
        },
      ],
    });
    expect(
      (response.data.topPositions as { items: Array<{ assetId: string }> })
        .items,
    ).toHaveLength(5);
    expect(JSON.stringify(response.data.topPositions)).not.toContain(
      'asset-zero',
    );
    expect(JSON.stringify(response.data.topPositions)).not.toContain(
      'asset-small',
    );
    expectNoHomeWrites(prisma);
  });

  it('uses fresh provider_api asset price for home top positions live valuation', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(
      latestSnapshot,
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
    prisma.position.findMany.mockResolvedValueOnce([
      position(
        'position-provider',
        'asset-provider',
        '2.00000000',
        '90.00000000',
        CurrencyCode.KRW,
        AssetType.domestic_stock,
      ),
    ]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-home',
        price: new Prisma.Decimal('110.00000000'),
        currencyCode: CurrencyCode.KRW,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_krx_realtime_trade',
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 1_000),
      },
    ]);

    const response = await service.getHome('user-1');

    expect(response.data.topPositions).toMatchObject({
      state: 'available',
      items: [
        {
          assetId: 'asset-provider',
          currentPrice: '110.00000000',
          assetPriceSnapshotId: 'provider-price-home',
          positionValueKrw: '220.00000000',
          returnRate: '22.22222222',
          priceSource: {
            sourceType: 'provider_api',
            sourceName: 'kis_krx_realtime_trade',
            snapshotId: 'provider-price-home',
            fallbackUsed: false,
          },
        },
      ],
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoHomeWrites(prisma);
  });

  it('marks allocation and topPositions unavailable without fake fallback when USD/KRW FX is stale', async () => {
    const { prisma, valuationService, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(
      latestSnapshot,
    );
    valuationService.calculateSeasonParticipantValuation.mockRejectedValueOnce(
      new PortfolioValuationError(
        'FX_RATE_STALE',
        'USD/KRW FX rate snapshot is stale.',
      ),
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
    prisma.position.findMany.mockResolvedValueOnce([
      position(
        'position-usd',
        'asset-usd',
        '1.00000000',
        '100.00000000',
        CurrencyCode.USD,
        AssetType.us_stock,
      ),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      ...freshUsdKrwSnapshot(),
      effectiveAt: new Date(Date.now() - 61_000),
    });

    const response = await service.getHome('user-1');

    expect(response.data.summary).toMatchObject({
      state: 'unavailable',
      reason: 'FX_RATE_STALE',
      valuationSource: 'unavailable',
    });
    expect(response.data.allocation).toMatchObject({
      state: 'unavailable',
      reason: 'FX_RATE_STALE',
    });
    expect(response.data.topPositions).toMatchObject({
      state: 'unavailable',
      reason: 'FX_RATE_STALE',
    });
    expect(response.data.sectionErrors).toEqual(
      expect.arrayContaining([
        {
          section: 'summary',
          code: 'FX_RATE_STALE',
          message: 'USD/KRW FX rate snapshot is stale.',
        },
        {
          section: 'allocation',
          code: 'FX_RATE_STALE',
          message: 'USD/KRW FX rate snapshot is stale.',
        },
        {
          section: 'topPositions',
          code: 'FX_RATE_STALE',
          message: 'USD/KRW FX rate snapshot is stale.',
        },
      ]),
    );
    expect(response.data.sectionErrors).toHaveLength(3);
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoHomeWrites(prisma);
  });

  it('marks allocation and topPositions unavailable without fake fallback when required price or FX data is missing', async () => {
    const { prisma, valuationService, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(
      latestSnapshot,
    );
    valuationService.calculateSeasonParticipantValuation.mockRejectedValueOnce(
      new PortfolioValuationError(
        'FX_RATE_UNAVAILABLE',
        'USD/KRW FX rate snapshot is unavailable.',
      ),
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
    prisma.position.findMany.mockResolvedValueOnce([
      position('position-1', 'asset-1', '1.00000000', '100.00000000'),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(response.data.summary).toMatchObject({
      state: 'unavailable',
      reason: 'FX_RATE_UNAVAILABLE',
      valuationSource: 'unavailable',
    });
    expect(response.data.allocation).toMatchObject({
      state: 'unavailable',
      reason: 'FX_RATE_UNAVAILABLE',
    });
    expect(response.data.topPositions).toMatchObject({
      state: 'unavailable',
      reason: 'ASSET_PRICE_UNAVAILABLE',
    });
    expect(response.data.sectionErrors).toEqual(
      expect.arrayContaining([
        {
          section: 'summary',
          code: 'FX_RATE_UNAVAILABLE',
          message: 'USD/KRW FX rate snapshot is unavailable.',
        },
        {
          section: 'allocation',
          code: 'FX_RATE_UNAVAILABLE',
          message: 'USD/KRW FX rate snapshot is unavailable.',
        },
        {
          section: 'topPositions',
          code: 'ASSET_PRICE_UNAVAILABLE',
          message: 'Asset price snapshot is unavailable for asset asset-1.',
        },
      ]),
    );
    expect(response.data.sectionErrors).toHaveLength(3);
    expectNoHomeWrites(prisma);
  });

  it('returns equityChart from existing daily portfolio snapshots in chronological order', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(null);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      {
        snapshotDate: new Date('2026-05-08T00:00:00.000Z'),
        totalAssetKrw: new Prisma.Decimal('1210000.00000000'),
        returnRate: new Prisma.Decimal('21.00000000'),
        capturedAt: new Date('2026-05-08T00:01:00.000Z'),
      },
      {
        snapshotDate: new Date('2026-05-07T00:00:00.000Z'),
        totalAssetKrw: new Prisma.Decimal('1200000.00000000'),
        returnRate: new Prisma.Decimal('20.00000000'),
        capturedAt: new Date('2026-05-07T00:01:00.000Z'),
      },
    ]);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(prisma.dailyPortfolioSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'participant-1',
        },
        take: 30,
      }),
    );
    expect(response.data.equityChart).toMatchObject({
      state: 'available',
      chartSource: 'daily_portfolio_snapshots',
      items: [
        {
          snapshotDate: '2026-05-07',
          totalAssetKrw: '1200000.00000000',
          returnRate: '20.00000000',
          capturedAt: '2026-05-07T00:01:00.000Z',
        },
        {
          snapshotDate: '2026-05-08',
          totalAssetKrw: '1210000.00000000',
          returnRate: '21.00000000',
          capturedAt: '2026-05-08T00:01:00.000Z',
        },
      ],
    });
    expectNoHomeWrites(prisma);
  });

  it('returns equityChart unavailable when no daily portfolio snapshots exist', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce(null);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(response.data.equityChart).toMatchObject({
      state: 'unavailable',
      reason: 'EQUITY_CHART_UNAVAILABLE',
      chartSource: 'daily_portfolio_snapshots',
      items: [],
    });
    expectNoHomeWrites(prisma);
  });

  it('returns active not joined guide state', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'active_not_joined',
      guide: {
        state: 'blocked',
        reason: 'SEASON_NOT_JOINED',
        action: 'JOIN_SEASON',
      },
      summary: {
        state: 'blocked',
        reason: 'SEASON_NOT_JOINED',
      },
    });
    expect(prisma.dailyPortfolioSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoHomeWrites(prisma);
  });

  it('uses upcoming mode when DB status is active before startAt', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce({
      ...activeSeason,
      startAt: new Date(Date.now() + 86_400_000),
      endAt: new Date(Date.now() + 172_800_000),
    });

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'upcoming',
      season: {
        status: SeasonStatus.active,
      },
      guide: {
        state: 'blocked',
        reason: 'SEASON_UPCOMING',
      },
    });
    expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
    expectNoHomeWrites(prisma);
  });

  it('uses ended mode when DB status is active after endAt', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce({
      ...activeSeason,
      startAt: new Date(Date.now() - 172_800_000),
      endAt: new Date(Date.now() - 86_400_000),
    });

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'ended',
      season: {
        status: SeasonStatus.active,
      },
      guide: {
        state: 'blocked',
        reason: 'SEASON_ENDED_SETTLEMENT_PENDING',
      },
    });
    expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
    expectNoHomeWrites(prisma);
  });

  it('returns no current season state when no season exists', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'no_current_season',
      season: null,
      guide: {
        state: 'unavailable',
        reason: 'CURRENT_SEASON_NOT_FOUND',
      },
    });
    expect(prisma.season.findFirst).toHaveBeenCalledTimes(4);
    expectNoHomeWrites(prisma);
  });

  it('returns upcoming season blocked guide state', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...activeSeason,
      status: SeasonStatus.upcoming,
    });

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'upcoming',
      guide: {
        state: 'blocked',
        reason: 'SEASON_UPCOMING',
        action: null,
      },
      trading: {
        state: 'blocked',
        reason: 'SEASON_UPCOMING',
      },
    });
    expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
    expectNoHomeWrites(prisma);
  });

  it('returns ended season settlement pending state', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...activeSeason,
        status: SeasonStatus.ended,
      });

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'ended',
      guide: {
        state: 'blocked',
        reason: 'SEASON_ENDED_SETTLEMENT_PENDING',
      },
      summary: {
        state: 'unavailable',
        reason: 'SETTLEMENT_PENDING',
      },
      ranking: {
        state: 'unavailable',
        reason: 'SETTLEMENT_PENDING',
      },
    });
    expectNoHomeWrites(prisma);
  });

  it('returns settled joined final result from final season rankings and daily snapshots without writes', async () => {
    const { prisma, service } = createService();
    mockSettledSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      settledParticipant,
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(finalRanking);
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      chartSnapshot('2026-05-21', '11230000.00000000', '12.30000000'),
      chartSnapshot('2026-05-20', '11000000.00000000', '10.00000000'),
    ]);

    const response = await service.getHome('user-1');

    expect(prisma.seasonParticipant.findUnique).toHaveBeenCalledWith({
      where: {
        seasonId_userId: {
          seasonId: 'season-1',
          userId: 'user-1',
        },
      },
      select: {
        id: true,
        participantStatus: true,
        joinedAt: true,
        initialCapitalKrw: true,
        finalTier: true,
        rewardGrantedAt: true,
      },
    });
    expect(prisma.seasonRanking.findFirst).toHaveBeenCalledWith({
      where: {
        seasonId: 'season-1',
        seasonParticipantId: 'participant-1',
        rankType: SeasonRankingType.final,
      },
      orderBy: [
        { rankingDate: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rank: true,
        totalAssetKrw: true,
        returnRate: true,
        maxDrawdown: true,
        totalFillCount: true,
        reachedReturnAt: true,
        rankingDate: true,
        capturedAt: true,
      },
    });
    expect(prisma.seasonRanking.count).toHaveBeenCalledWith({
      where: {
        seasonId: 'season-1',
        rankType: SeasonRankingType.final,
        rankingDate: finalRanking.rankingDate,
      },
    });
    expect(response.data).toMatchObject({
      mode: 'settled_joined',
      trading: {
        state: 'blocked',
        reason: 'SEASON_SETTLED',
      },
      exchange: {
        state: 'blocked',
        reason: 'SEASON_SETTLED',
      },
      finalResult: {
        state: 'available',
        resultSource: 'season_rankings',
        rankType: SeasonRankingType.final,
        rank: 12,
        totalParticipants: 100,
        totalAssetKrw: '11230000.00000000',
        returnRate: '12.30000000',
        maxDrawdown: '4.00000000',
        totalFillCount: 7,
        reachedReturnAt: '2026-05-20T00:01:00.000Z',
        rankingDate: '2026-05-21',
        capturedAt: '2026-05-21T00:00:30.000Z',
        tier: {
          state: 'available',
          finalTier: 'gold',
        },
        reward: {
          state: 'pending',
          grantedAt: null,
          code: 'REWARD_NOT_GRANTED',
        },
      },
      equityChart: {
        state: 'available',
        chartSource: 'daily_portfolio_snapshots',
        items: [
          {
            snapshotDate: '2026-05-20',
            totalAssetKrw: '11000000.00000000',
            returnRate: '10.00000000',
          },
          {
            snapshotDate: '2026-05-21',
            totalAssetKrw: '11230000.00000000',
            returnRate: '12.30000000',
          },
        ],
      },
    });
    expect(response.data.sectionErrors).toEqual([
      {
        section: 'finalResult.reward',
        code: 'REWARD_NOT_GRANTED',
        message: 'Reward has not been granted yet.',
      },
    ]);
    expectNoHomeWrites(prisma);
  });

  it('returns settled joined final tier unavailable and granted reward states from participant fields', async () => {
    const { prisma, service } = createService();
    mockSettledSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      ...settledParticipant,
      finalTier: null,
      rewardGrantedAt: new Date('2026-05-22T00:00:00.000Z'),
    });
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(finalRanking);
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      chartSnapshot('2026-05-21', '11230000.00000000', '12.30000000'),
    ]);

    const response = await service.getHome('user-1');

    expect(response.data.finalResult).toMatchObject({
      state: 'available',
      tier: {
        state: 'unavailable',
        code: 'FINAL_TIER_UNAVAILABLE',
      },
      reward: {
        state: 'granted',
        grantedAt: '2026-05-22T00:00:00.000Z',
      },
    });
    expect(response.data.sectionErrors).toEqual([
      {
        section: 'finalResult.tier',
        code: 'FINAL_TIER_UNAVAILABLE',
        message: 'Final tier assignment is not available yet.',
      },
    ]);
    expectNoHomeWrites(prisma);
  });

  it('returns settled joined granted reward state when rewardGrantedAt exists', async () => {
    const { prisma, service } = createService();
    mockSettledSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      ...settledParticipant,
      rewardGrantedAt: new Date('2026-05-22T01:02:03.000Z'),
    });
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(finalRanking);
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      chartSnapshot('2026-05-21', '11230000.00000000', '12.30000000'),
    ]);

    const response = await service.getHome('user-1');

    expect(response.data.finalResult).toMatchObject({
      state: 'available',
      tier: {
        state: 'available',
        finalTier: 'gold',
      },
      reward: {
        state: 'granted',
        grantedAt: '2026-05-22T01:02:03.000Z',
      },
    });
    expect(response.data.sectionErrors).toEqual([]);
    expectNoHomeWrites(prisma);
  });

  it('returns settled joined finalResult unavailable when final ranking is missing without fake fallback', async () => {
    const { prisma, valuationService, service } = createService();
    mockSettledSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      settledParticipant,
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      chartSnapshot('2026-05-21', '11230000.00000000', '12.30000000'),
    ]);

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'settled_joined',
      finalResult: {
        state: 'unavailable',
        reason: 'FINAL_RANKING_UNAVAILABLE',
        resultSource: 'season_rankings',
        rankType: SeasonRankingType.final,
      },
    });
    expect(response.data.finalResult).not.toHaveProperty('rank');
    expect(response.data.finalResult).not.toHaveProperty('totalAssetKrw');
    expect(prisma.seasonRanking.count).not.toHaveBeenCalled();
    expect(
      valuationService.calculateSeasonParticipantValuation,
    ).not.toHaveBeenCalled();
    expect(response.data.sectionErrors).toEqual(
      expect.arrayContaining([
        {
          section: 'finalResult',
          code: 'FINAL_RANKING_UNAVAILABLE',
          message:
            'Final ranking is unavailable for the settled season participant.',
        },
      ]),
    );
    expectNoHomeWrites(prisma);
  });

  it('keeps settled finalResult available when daily snapshots for chart are missing', async () => {
    const { prisma, service } = createService();
    mockSettledSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      settledParticipant,
    );
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(finalRanking);
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([]);

    const response = await service.getHome('user-1');

    expect(response.data.finalResult).toMatchObject({
      state: 'available',
      rank: 12,
    });
    expect(response.data.equityChart).toMatchObject({
      state: 'unavailable',
      reason: 'FINAL_SNAPSHOT_UNAVAILABLE',
      chartSource: 'daily_portfolio_snapshots',
      items: [],
    });
    expect(response.data.sectionErrors).toEqual(
      expect.arrayContaining([
        {
          section: 'equityChart',
          code: 'FINAL_SNAPSHOT_UNAVAILABLE',
          message:
            'Final equity chart is unavailable because daily portfolio snapshots are missing.',
        },
      ]),
    );
    expectNoHomeWrites(prisma);
  });

  it('returns settled not joined guide state without final result lookup', async () => {
    const { prisma, service } = createService();
    mockSettledSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'settled_not_joined',
      guide: {
        state: 'blocked',
        reason: 'SEASON_NOT_JOINED',
        action: null,
      },
      finalResult: {
        state: 'blocked',
        reason: 'SEASON_NOT_JOINED',
      },
      equityChart: {
        state: 'blocked',
        reason: 'SEASON_NOT_JOINED',
      },
    });
    expect(prisma.seasonRanking.findFirst).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.findMany).not.toHaveBeenCalled();
    expectNoHomeWrites(prisma);
  });

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expect(service.getHome(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
