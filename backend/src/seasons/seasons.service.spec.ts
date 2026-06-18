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

import { Prisma, SeasonStatus } from '../generated/prisma/client';
import { SeasonsService } from './seasons.service';

describe('SeasonsService', () => {
  const createPrisma = () => ({
    season: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    cashWallet: {
      create: jest.fn(),
    },
    walletTransaction: {
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
});
