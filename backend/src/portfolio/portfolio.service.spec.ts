jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
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
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { PortfolioService } from './portfolio.service';

describe('PortfolioService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');
  const capturedAt = new Date('2026-05-07T00:00:00.000Z');

  const season = {
    id: 'season-1',
    name: 'Season 1',
    status: SeasonStatus.active,
    startAt,
    endAt,
  };

  const participant = {
    id: 'sp-1',
    participantStatus: ParticipantStatus.active,
    joinedAt,
  };

  const valuation = {
    seasonParticipantId: 'sp-1',
    totalAssetKrw: '10452345.12000000',
    returnRate: '4.52345120',
    krwCash: '2500000.00000000',
    usdCashKrw: '4672730.00000000',
    assetValueKrw: '3279615.12000000',
    domesticStockValueKrw: '1500000.00000000',
    usStockValueKrw: '900000.00000000',
    cryptoValueKrw: '879615.12000000',
    realizedPnlKrw: '0.00000000',
    unrealizedPnlKrw: '452345.12000000',
    valuationAt: capturedAt,
    sourceSummary: {
      providerApiUsed: false,
      adminManualUsed: true,
      fallbackUsed: false,
      fallbackReasons: [],
      rejectedProviderReasons: [],
    },
    assetPriceSourceDecisions: [],
    fxRateSourceDecision: null,
  };

  const createPrisma = () => ({
    season: {
      findFirst: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
    },
    equitySnapshot: {
      findMany: jest.fn(),
    },
    dailyPortfolioSnapshot: {
      findMany: jest.fn(),
    },
  });

  const createService = () => {
    const prisma = createPrisma();
    const portfolioValuationService = {
      calculateSeasonParticipantValuation: jest
        .fn()
        .mockResolvedValue(valuation),
    };
    const service = new PortfolioService(
      prisma as never,
      portfolioValuationService as never,
    );

    return { portfolioValuationService, prisma, service };
  };

  const mockCurrentSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(season);
  };

  const mockJoined = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
  };

  it('returns current portfolio summary from the shared valuation service', async () => {
    const { portfolioValuationService, prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);

    const response = await service.getPortfolio('user-1');

    expect(
      portfolioValuationService.calculateSeasonParticipantValuation,
    ).toHaveBeenCalledWith('sp-1', expect.any(Date), 'home_live_valuation');
    expect(response.data).toMatchObject({
      state: 'available',
      summary: {
        totalAssetKrw: '10452345.12000000',
        returnRate: '4.52345120',
        krwCash: '2500000.00000000',
      },
      allocation: {
        state: 'available',
        cashKrwValue: '7172730.00000000',
        domesticStockValueKrw: '1500000.00000000',
        usStockValueKrw: '900000.00000000',
        cryptoValueKrw: '879615.12000000',
      },
      sectionErrors: [],
    });
  });

  it('returns not_joined portfolio state without valuing private data', async () => {
    const { portfolioValuationService, prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getPortfolio('user-1');

    expect(response.data).toMatchObject({
      state: 'not_joined',
      summary: null,
      allocation: {
        state: 'not_joined',
      },
      reason: 'SEASON_NOT_JOINED',
    });
    expect(
      portfolioValuationService.calculateSeasonParticipantValuation,
    ).not.toHaveBeenCalled();
  });

  it('returns equity points for 1d range from equity snapshots', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.equitySnapshot.findMany.mockResolvedValueOnce([
      {
        capturedAt,
        totalAssetKrw: new Prisma.Decimal('10000000.00000000'),
        returnRate: new Prisma.Decimal('0.00000000'),
      },
    ]);

    const response = await service.getEquity('user-1', { range: '1d' });

    expect(response.data).toEqual({
      state: 'available',
      range: '1d',
      points: [
        {
          time: '2026-05-07T00:00:00.000Z',
          totalAssetKrw: '10000000.00000000',
          returnRate: '0.00000000',
        },
      ],
    });
  });

  it('returns empty equity state when snapshots are absent', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.equitySnapshot.findMany.mockResolvedValueOnce([]);

    const response = await service.getEquity('user-1', { range: 'season' });

    expect(response.data).toEqual({
      state: 'empty',
      range: 'season',
      points: [],
    });
  });

  it('rejects invalid range and missing authenticated user', async () => {
    const { service } = createService();

    await expect(
      service.getEquity('user-1', { range: '30d' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(service.getPortfolio(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(service.getEquity(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
