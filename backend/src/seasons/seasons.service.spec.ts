jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    ParticipantStatus: {
      active: 'active',
      registered: 'registered',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: {
      Decimal,
      PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
    },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      active: 'active',
      ended: 'ended',
      settled: 'settled',
      upcoming: 'upcoming',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
    },
    TradingAccountMode: {
      season: 'season',
      general: 'general',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
    UserStatus: {
      active: 'active',
      suspended: 'suspended',
      deleted: 'deleted',
    },
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      season_join: 'season_join',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
    },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma, SeasonStatus } from '../generated/prisma/client';
import { deriveSeasonTradingAccountId } from './season-trading-account-link';
import { SeasonsService } from './seasons.service';

describe('SeasonsService', () => {
  const createPrisma = () => ({
    season: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    tradingAccount: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    user: {
      findUnique: jest.fn(),
    },
    cashWallet: {
      create: jest.fn(),
    },
    walletTransaction: {
      create: jest.fn(),
    },
    equitySnapshot: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    const service = new SeasonsService(prisma as never);

    return { prisma, service };
  };

  const season = (input: {
    status: SeasonStatus;
    startAt: Date;
    endAt: Date;
  }) => ({
    id: 'season-1',
    name: 'Season 1',
    status: input.status,
    startAt: input.startAt,
    endAt: input.endAt,
    initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
    tradeFeeRate: new Prisma.Decimal('0.001000'),
    fxFeeRate: new Prisma.Decimal('0.002000'),
  });

  it('returns active effective mode inside an active season window', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce(
      season({
        status: SeasonStatus.active,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() + 86_400_000),
      }),
    );
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      joinedAt: new Date('2026-05-02T00:00:00.000Z'),
    });

    const response = await service.getCurrentSeason('user-1');

    expect(response.data).toMatchObject({
      status: SeasonStatus.active,
      effectiveStatus: SeasonStatus.active,
      effectiveMode: 'active',
      joined: true,
      joinedAt: '2026-05-02T00:00:00.000Z',
    });
  });

  it('returns upcoming effective mode when DB status is active before startAt', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce(
      season({
        status: SeasonStatus.active,
        startAt: new Date(Date.now() + 86_400_000),
        endAt: new Date(Date.now() + 172_800_000),
      }),
    );

    const response = await service.getCurrentSeason();

    expect(response.data).toMatchObject({
      status: SeasonStatus.active,
      effectiveStatus: SeasonStatus.upcoming,
      effectiveMode: 'upcoming',
      joined: false,
      joinedAt: null,
    });
  });

  it('returns ended effective mode when DB status is active after endAt', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce(
      season({
        status: SeasonStatus.active,
        startAt: new Date(Date.now() - 172_800_000),
        endAt: new Date(Date.now() - 86_400_000),
      }),
    );

    const response = await service.getCurrentSeason();

    expect(response.data).toMatchObject({
      status: SeasonStatus.active,
      effectiveStatus: SeasonStatus.ended,
      effectiveMode: 'ended',
    });
  });

  it('lists seasons with status filter and offset pagination', async () => {
    const { prisma, service } = createService();
    prisma.season.count.mockResolvedValueOnce(3);
    prisma.season.findMany.mockResolvedValueOnce([
      season({
        status: SeasonStatus.settled,
        startAt: new Date('2026-03-01T00:00:00.000Z'),
        endAt: new Date('2026-03-31T00:00:00.000Z'),
      }),
      {
        ...season({
          status: SeasonStatus.settled,
          startAt: new Date('2026-02-01T00:00:00.000Z'),
          endAt: new Date('2026-02-28T00:00:00.000Z'),
        }),
        id: 'season-2',
      },
    ]);

    const response = await service.getSeasons({
      status: 'settled',
      limit: '2',
      offset: '1',
    });

    expect(prisma.season.count).toHaveBeenCalledWith({
      where: {
        status: SeasonStatus.settled,
      },
    });
    expect(prisma.season.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: SeasonStatus.settled,
        },
        skip: 1,
        take: 2,
      }),
    );
    expect(response.data).toMatchObject({
      state: 'available',
      pagination: {
        limit: 2,
        offset: 1,
        total: 3,
        returned: 2,
        nextOffset: null,
      },
      seasons: [
        {
          id: 'season-1',
          status: SeasonStatus.settled,
          effectiveMode: 'settled',
          initialCapitalKrw: '1000000.00000000',
          tradeFeeRate: '0.001000',
          fxFeeRate: '0.002000',
        },
        {
          id: 'season-2',
        },
      ],
    });
  });

  it('rejects invalid season list status', async () => {
    const { service } = createService();

    await expect(
      service.getSeasons({ status: 'archived' }),
    ).rejects.toBeInstanceOf(Error);
  });

  const activeSeason = () =>
    season({
      status: SeasonStatus.active,
      startAt: new Date(Date.now() - 86_400_000),
      endAt: new Date(Date.now() + 86_400_000),
    });

  const existingParticipant = (tradingAccountId: string | null) => ({
    id: 'sp-existing',
    userId: 'user-1',
    joinedAt: new Date('2026-05-02T00:00:00.000Z'),
    participantStatus: 'active',
    initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
    tradingAccountId,
  });

  const expectStatus = async (work: Promise<unknown>, status: number) => {
    let caught: unknown;
    try {
      await work;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(status);
    return caught as HttpException;
  };

  it('returns 409 without touching accounts when the existing participant is already linked', async () => {
    const { prisma, service } = createService();
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.season.findUnique.mockResolvedValueOnce(activeSeason());
    prisma.user.findUnique.mockResolvedValueOnce({ status: 'active' });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      existingParticipant('ta-existing'),
    );

    const error = await expectStatus(
      service.joinSeason('season-1', 'user-1'),
      409,
    );

    expect(
      (error.getResponse() as { error: { code: string } }).error.code,
    ).toBe('SEASON_ALREADY_JOINED');
    expect(prisma.tradingAccount.create).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.tradingAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
  });

  it('repairs a legacy null trading-account link and still returns 409', async () => {
    const { prisma, service } = createService();
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.season.findUnique.mockResolvedValueOnce(activeSeason());
    prisma.user.findUnique.mockResolvedValueOnce({ status: 'active' });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      existingParticipant(null),
    );
    prisma.tradingAccount.findUnique
      .mockResolvedValueOnce(null)
      // Post-insert re-read validation of the stored deterministic row.
      .mockResolvedValueOnce({
        id: deriveSeasonTradingAccountId('sp-existing'),
        userId: 'user-1',
        mode: 'season',
        status: 'active',
        initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
        openedAt: new Date('2026-05-02T00:00:00.000Z'),
        seasonParticipant: null,
      });
    prisma.seasonParticipant.updateMany.mockResolvedValueOnce({ count: 1 });

    const error = await expectStatus(
      service.joinSeason('season-1', 'user-1'),
      409,
    );

    const deterministicId = deriveSeasonTradingAccountId('sp-existing');
    expect(
      (error.getResponse() as { error: { code: string } }).error.code,
    ).toBe('SEASON_ALREADY_JOINED');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([
      deterministicId,
      'user-1',
      'season',
      'active',
      '1000000.00000000',
      new Date('2026-05-02T00:00:00.000Z'),
    ]);
    expect(prisma.seasonParticipant.updateMany).toHaveBeenCalledWith({
      where: { id: 'sp-existing', tradingAccountId: null },
      data: { tradingAccountId: deterministicId },
    });
    // Repair never re-creates wallets, grants, or snapshots.
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.create).not.toHaveBeenCalled();
  });

  it('surfaces a failed link repair as a 500 integrity error, not SEASON_ALREADY_JOINED', async () => {
    const { prisma, service } = createService();
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.season.findUnique.mockResolvedValueOnce(activeSeason());
    prisma.user.findUnique.mockResolvedValueOnce({ status: 'active' });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      existingParticipant(null),
    );
    // Deterministic id already taken by another user's account: fail closed.
    prisma.tradingAccount.findUnique.mockResolvedValueOnce({
      id: deriveSeasonTradingAccountId('sp-existing'),
      userId: 'user-other',
      mode: 'season',
      status: 'active',
      initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
      openedAt: new Date('2026-05-02T00:00:00.000Z'),
      seasonParticipant: null,
    });

    const error = await expectStatus(
      service.joinSeason('season-1', 'user-1'),
      500,
    );

    expect(
      (error.getResponse() as { error: { code: string } }).error.code,
    ).toBe('TRADING_ACCOUNT_LINK_INTEGRITY');
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('creates initial season_join equity snapshot inside season join transaction', async () => {
    const { prisma, service } = createService();
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.season.findUnique.mockResolvedValueOnce(
      season({
        status: SeasonStatus.active,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() + 86_400_000),
      }),
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      status: 'active',
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
    prisma.tradingAccount.create.mockResolvedValueOnce({
      id: 'ta-1',
    });
    prisma.seasonParticipant.create.mockResolvedValueOnce({
      id: 'sp-1',
    });
    prisma.cashWallet.create
      .mockResolvedValueOnce({
        id: 'wallet-krw-1',
      })
      .mockResolvedValueOnce({
        id: 'wallet-usd-1',
      });

    const response = await service.joinSeason('season-1', 'user-1');

    expect(response.data).toMatchObject({
      seasonParticipantId: 'sp-1',
      wallets: {
        KRW: '1000000.00000000',
        USD: '0.00000000',
      },
    });
    expect(prisma.tradingAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        mode: 'season',
        status: 'active',
        initialCapitalKrw: '1000000.00000000',
        openedAt: expect.any(Date),
      }),
      select: { id: true },
    });
    expect(prisma.seasonParticipant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tradingAccountId: 'ta-1',
        }),
      }),
    );
    // Transitional dual-write: KRW+USD wallets and the initial grant all
    // carry the created account id next to the participant id.
    expect(prisma.cashWallet.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'ta-1',
        currencyCode: 'KRW',
      }),
    });
    expect(prisma.cashWallet.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'ta-1',
        currencyCode: 'USD',
      }),
    });
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'ta-1',
        txType: 'initial_grant',
      }),
    });
    expect(prisma.equitySnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        seasonParticipantId: 'sp-1',
        totalAssetKrw: '1000000.00000000',
        returnRate: '0.00000000',
        krwCash: '1000000.00000000',
        usdCashKrw: '0.00000000',
        domesticStockValueKrw: '0.00000000',
        usStockValueKrw: '0.00000000',
        cryptoValueKrw: '0.00000000',
        snapshotReason: 'season_join',
        capturedAt: expect.any(Date),
      }),
    });
  });
});
