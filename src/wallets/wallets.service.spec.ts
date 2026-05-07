jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
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
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { WalletsService } from './wallets.service';

describe('WalletsService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');
  const updatedAt = new Date('2026-05-07T00:00:00.000Z');

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

  const createPrisma = () => ({
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
    cashWallet: {
      findMany: jest.fn(),
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
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    const service = new WalletsService(prisma as never);

    return { prisma, service };
  };

  const mockCurrentSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(season);
  };

  const expectNoWalletWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.cashWallet,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  it('returns active joined wallets', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.cashWallet.findMany.mockResolvedValueOnce([
      {
        currencyCode: CurrencyCode.KRW,
        balanceAmount: new Prisma.Decimal('10000000.00000000'),
        updatedAt,
      },
      {
        currencyCode: CurrencyCode.USD,
        balanceAmount: new Prisma.Decimal('100.00000000'),
        updatedAt,
      },
    ]);

    const response = await service.getWallets('user-1');

    expect(response.data).toMatchObject({
      state: 'available',
      participant: {
        id: 'sp-1',
        status: ParticipantStatus.active,
      },
      wallets: [
        {
          currencyCode: CurrencyCode.KRW,
          balanceAmount: '10000000.00000000',
          updatedAt: '2026-05-07T00:00:00.000Z',
        },
        {
          currencyCode: CurrencyCode.USD,
          balanceAmount: '100.00000000',
        },
      ],
      summary: {
        totalWallets: 2,
        hasKrwWallet: true,
        hasUsdWallet: true,
      },
    });
    expectNoWalletWrites(prisma);
  });

  it('returns not_joined without creating wallets', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getWallets('user-1');

    expect(response.data).toMatchObject({
      state: 'not_joined',
      wallets: [],
      reason: 'SEASON_NOT_JOINED',
    });
    expect(prisma.cashWallet.findMany).not.toHaveBeenCalled();
    expectNoWalletWrites(prisma);
  });

  it('returns unavailable when no current season exists', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    const response = await service.getWallets('user-1');

    expect(response.data).toMatchObject({
      state: 'unavailable',
      season: null,
      wallets: [],
      reason: 'CURRENT_SEASON_NOT_FOUND',
    });
    expect(prisma.season.findFirst).toHaveBeenCalledTimes(4);
    expectNoWalletWrites(prisma);
  });

  it('returns wallets for joined participant in non-active season', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...season,
        status: SeasonStatus.upcoming,
      });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.cashWallet.findMany.mockResolvedValueOnce([]);

    const response = await service.getWallets('user-1');

    expect(response.data).toMatchObject({
      state: 'available',
      season: {
        status: SeasonStatus.upcoming,
      },
      wallets: [],
      summary: {
        totalWallets: 0,
      },
    });
    expectNoWalletWrites(prisma);
  });

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expect(service.getWallets(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
