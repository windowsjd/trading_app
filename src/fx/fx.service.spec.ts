jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      active: 'active',
      upcoming: 'upcoming',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

import { HttpException } from '@nestjs/common';
import { CurrencyCode, Prisma, SeasonStatus } from '../generated/prisma/client';
import { FxService } from './fx.service';

const capturedAt = new Date('2026-05-01T01:02:03.000Z');
const effectiveAt = new Date('2026-05-01T00:00:00.000Z');

describe('FxService', () => {
  const createPrisma = () => ({
    season: {
      findFirst: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
    },
    fxRateSnapshot: {
      findFirst: jest.fn(),
    },
  });

  const getErrorCode = (error: unknown) => {
    const response = (error as HttpException).getResponse() as {
      error: { code: string };
    };

    return response.error.code;
  };

  const expectErrorCode = async (
    promise: Promise<unknown>,
    code: string,
  ) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);

    try {
      await promise;
    } catch (error) {
      expect(getErrorCode(error)).toBe(code);
    }
  };

  const createService = () => {
    const prisma = createPrisma();
    const service = new FxService(prisma as never);

    return { prisma, service };
  };

  const mockActiveSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce({
      id: 'season-1',
      status: SeasonStatus.active,
      fxFeeRate: new Prisma.Decimal('0.001000'),
    });
  };

  const mockJoinedParticipant = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'participant-1',
    });
  };

  const mockApprovedRateSnapshot = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      rate: new Prisma.Decimal('1350.00000000'),
      capturedAt,
      effectiveAt,
    });
  };

  it('rejects invalid currency pair', async () => {
    const { prisma, service } = createService();

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'KRW',
        sourceAmount: '1000',
      }),
      'INVALID_CURRENCY_PAIR',
    );
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
  });

  it('rejects invalid amount', async () => {
    const { prisma, service } = createService();

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '0',
      }),
      'INVALID_AMOUNT',
    );
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
  });

  it('rejects when there is no season', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'SEASON_NOT_FOUND',
    );
  });

  it('rejects when current season is not active', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'season-1',
        status: SeasonStatus.upcoming,
        fxFeeRate: new Prisma.Decimal('0.001000'),
      });

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'SEASON_NOT_ACTIVE',
    );
  });

  it('rejects when user has not joined the active season', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'SEASON_NOT_JOINED',
    );
  });

  it('rejects when no approved rate snapshot is available', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(null);

    await expectErrorCode(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
      'FX_RATE_UNAVAILABLE',
    );
  });

  it('selects the latest eligible USD/KRW rate snapshot', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma);

    await service.quote('user-1', {
      fromCurrency: 'KRW',
      toCurrency: 'USD',
      sourceAmount: '135000',
    });

    expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalledWith({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        effectiveAt: {
          lte: expect.any(Date),
        },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      select: {
        rate: true,
        capturedAt: true,
        effectiveAt: true,
      },
    });
  });

  it('calculates KRW to USD quote', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000',
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        quoteId: null,
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: '135000.00000000',
        appliedRate: '1350.00000000',
        grossTargetAmount: '100.00000000',
        feeRate: '0.001000',
        feeAmount: '0.10000000',
        feeCurrency: CurrencyCode.USD,
        netTargetAmount: '99.90000000',
        expiresAt: null,
        rateCapturedAt: capturedAt.toISOString(),
        rateEffectiveAt: effectiveAt.toISOString(),
      },
    });
  });

  it('calculates USD to KRW quote', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoinedParticipant(prisma);
    mockApprovedRateSnapshot(prisma);

    await expect(
      service.quote('user-1', {
        fromCurrency: 'USD',
        toCurrency: 'KRW',
        sourceAmount: '100',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        fromCurrency: CurrencyCode.USD,
        toCurrency: CurrencyCode.KRW,
        sourceAmount: '100.00000000',
        appliedRate: '1350.00000000',
        grossTargetAmount: '135000.00000000',
        feeRate: '0.001000',
        feeAmount: '135.00000000',
        feeCurrency: CurrencyCode.KRW,
        netTargetAmount: '134865.00000000',
        rateCapturedAt: capturedAt.toISOString(),
        rateEffectiveAt: effectiveAt.toISOString(),
      },
    });
  });
});
