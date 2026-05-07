jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
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
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import { HomeService } from './home.service';

describe('HomeService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');

  const createPrisma = () => {
    const prisma = {
      season: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      seasonParticipant: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      dailyPortfolioSnapshot: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      seasonRanking: {
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
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
      walletTransaction: {
        create: jest.fn(),
      },
      exchangeTransaction: {
        create: jest.fn(),
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
    calculateSeasonParticipantValuation: jest.fn(),
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

  const expectNoHomeWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.dailyPortfolioSnapshot,
      prisma.seasonRanking,
      prisma.cashWallet,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.seasonRanking.deleteMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
  };

  it('returns active joined home using the latest daily snapshot first', async () => {
    const { prisma, valuationService, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.dailyPortfolioSnapshot.findFirst.mockResolvedValueOnce({
      snapshotDate: new Date('2026-05-07T00:00:00.000Z'),
      totalAssetKrw: new Prisma.Decimal('1100000.00000000'),
      returnRate: new Prisma.Decimal('0.10000000'),
      krwCash: new Prisma.Decimal('900000.00000000'),
      usdCashKrw: new Prisma.Decimal('140000.00000000'),
      assetValueKrw: new Prisma.Decimal('60000.00000000'),
      realizedPnlKrw: new Prisma.Decimal('10000.00000000'),
      unrealizedPnlKrw: new Prisma.Decimal('20000.00000000'),
      capturedAt: new Date('2026-05-07T00:01:00.000Z'),
    });
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);

    const response = await service.getHome('user-1');

    expect(response.data.mode).toBe('active_joined');
    expect(response.data.summary).toMatchObject({
      state: 'available',
      valuationSource: 'daily_snapshot',
      snapshotDate: '2026-05-07',
      totalAssetKrw: '1100000.00000000',
      returnRate: '0.10000000',
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
    expect(
      valuationService.calculateSeasonParticipantValuation,
    ).not.toHaveBeenCalled();
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
      returnRate: '0.20000000',
      krwCash: '900000.00000000',
      usdCashKrw: '140000.00000000',
      assetValueKrw: '160000.00000000',
      realizedPnlKrw: '10000.00000000',
      unrealizedPnlKrw: '20000.00000000',
      valuationAt: new Date('2026-05-07T00:02:00.000Z'),
    });
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rank: 3,
      rankType: SeasonRankingType.daily,
      rankingDate: new Date('2026-05-07T00:00:00.000Z'),
      totalAssetKrw: new Prisma.Decimal('1200000.00000000'),
      returnRate: new Prisma.Decimal('0.20000000'),
      capturedAt: new Date('2026-05-07T00:03:00.000Z'),
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(10);

    const response = await service.getHome('user-1');

    expect(response.data.summary).toMatchObject({
      state: 'available',
      valuationSource: 'live_valuation',
      valuationAt: '2026-05-07T00:02:00.000Z',
      totalAssetKrw: '1200000.00000000',
    });
    expect(response.data.ranking).toMatchObject({
      state: 'available',
      rankingSource: 'season_rankings',
      currentRank: 3,
      totalParticipants: 10,
      rankingDate: '2026-05-07',
    });
    expect(
      valuationService.calculateSeasonParticipantValuation,
    ).toHaveBeenCalledWith('participant-1');
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
    expect(response.data.sectionErrors).toEqual([
      {
        section: 'summary',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable.',
      },
    ]);
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
    prisma.season.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
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

  it('returns settled season read-only blocked trading state', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...activeSeason,
        status: SeasonStatus.settled,
      });

    const response = await service.getHome('user-1');

    expect(response.data).toMatchObject({
      mode: 'settled',
      trading: {
        state: 'blocked',
        reason: 'SEASON_SETTLED',
      },
      exchange: {
        state: 'blocked',
        reason: 'SEASON_SETTLED',
      },
      finalResult: {
        state: 'unavailable',
        reason: 'FINAL_RESULT_UNAVAILABLE',
      },
    });
    expectNoHomeWrites(prisma);
  });

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expect(service.getHome(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
