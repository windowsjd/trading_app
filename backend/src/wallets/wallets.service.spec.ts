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
      excluded: 'excluded',
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
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      exchange_source: 'exchange_source',
      exchange_target: 'exchange_target',
      order_buy: 'order_buy',
      order_sell: 'order_sell',
      fee: 'fee',
      adjustment: 'adjustment',
      settlement: 'settlement',
    },
  };
});

import { HttpException } from '@nestjs/common';
import {
  CurrencyCode,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  WalletTransactionType,
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
      count: jest.fn(),
      findMany: jest.fn(),
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

  const walletTransaction = (
    input: {
      id?: string;
      currencyCode?: CurrencyCode;
      direction?: 'credit' | 'debit';
      txType?: string;
      referenceType?: string;
    } = {},
  ) => ({
    id: input.id ?? 'wtx-1',
    currencyCode: input.currencyCode ?? CurrencyCode.KRW,
    direction: input.direction ?? 'credit',
    txType: input.txType ?? WalletTransactionType.initial_grant,
    referenceType: input.referenceType ?? 'season_join',
    referenceId: 'sp-1',
    amount: new Prisma.Decimal('10000000.00000000'),
    balanceAfter: new Prisma.Decimal('10000000.00000000'),
    occurredAt: joinedAt,
    createdAt: joinedAt,
  });

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
    prisma.season.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
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

  it('returns my wallet transactions with currency filter and pagination', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.walletTransaction.count.mockResolvedValueOnce(3);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'wtx-1',
        currencyCode: CurrencyCode.KRW,
        direction: 'credit',
        txType: 'initial_grant',
        referenceType: 'season_join',
        referenceId: 'sp-1',
        amount: new Prisma.Decimal('10000000.00000000'),
        balanceAfter: new Prisma.Decimal('10000000.00000000'),
        occurredAt: joinedAt,
        createdAt: joinedAt,
      },
    ]);

    const response = await service.getWalletTransactions('user-1', {
      currency: 'KRW',
      limit: '1',
      offset: '1',
    });

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.KRW,
        },
        skip: 1,
        take: 1,
      }),
    );
    expect(response.data).toMatchObject({
      state: 'available',
      filters: {
        currency: CurrencyCode.KRW,
        direction: null,
        txType: null,
      },
      transactions: [
        {
          id: 'wtx-1',
          amount: '10000000.00000000',
          balanceAfter: '10000000.00000000',
        },
      ],
      pagination: {
        limit: 1,
        offset: 1,
        total: 3,
        returned: 1,
        nextOffset: 2,
      },
    });
    expect(JSON.stringify(response.data)).not.toContain('walletId');
    expectNoWalletWrites(prisma);
  });

  it('filters by currency', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      walletTransaction({ currencyCode: CurrencyCode.USD }),
    ]);

    await service.getWalletTransactions('user-1', {
      currency: 'USD',
    });

    expect(prisma.walletTransaction.count).toHaveBeenCalledWith({
      where: {
        seasonParticipantId: 'sp-1',
        currencyCode: CurrencyCode.USD,
      },
    });
    expectNoWalletWrites(prisma);
  });

  it('filters by direction credit', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      walletTransaction({ direction: 'credit' }),
    ]);

    const response = await service.getWalletTransactions('user-1', {
      direction: 'credit',
    });

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          direction: 'credit',
        },
      }),
    );
    expect(response.data.filters).toEqual({
      currency: null,
      direction: 'credit',
      txType: null,
    });
    expectNoWalletWrites(prisma);
  });

  it('filters by direction debit', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      walletTransaction({ direction: 'debit' }),
    ]);

    await service.getWalletTransactions('user-1', {
      direction: 'debit',
    });

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          direction: 'debit',
        },
      }),
    );
    expectNoWalletWrites(prisma);
  });

  it('filters by txType', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      walletTransaction({ txType: WalletTransactionType.initial_grant }),
    ]);

    const response = await service.getWalletTransactions('user-1', {
      txType: WalletTransactionType.initial_grant,
    });

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          txType: WalletTransactionType.initial_grant,
        },
      }),
    );
    expect(response.data.filters).toEqual({
      currency: null,
      direction: null,
      txType: WalletTransactionType.initial_grant,
    });
    expectNoWalletWrites(prisma);
  });

  it('filters by currency + direction + txType together', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      walletTransaction({
        currencyCode: CurrencyCode.KRW,
        direction: 'credit',
        txType: WalletTransactionType.initial_grant,
      }),
    ]);

    await service.getWalletTransactions('user-1', {
      currency: 'KRW',
      direction: 'credit',
      txType: WalletTransactionType.initial_grant,
    });

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.KRW,
          direction: 'credit',
          txType: WalletTransactionType.initial_grant,
        },
      }),
    );
    expectNoWalletWrites(prisma);
  });

  it('returns filters object in available response', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.walletTransaction.count.mockResolvedValueOnce(0);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([]);

    const response = await service.getWalletTransactions('user-1', {
      currency: 'KRW',
      direction: 'credit',
      txType: WalletTransactionType.initial_grant,
    });

    expect(response.data.filters).toEqual({
      currency: CurrencyCode.KRW,
      direction: 'credit',
      txType: WalletTransactionType.initial_grant,
    });
    expectNoWalletWrites(prisma);
  });

  it('returns not_joined for wallet transactions without reading private ledgers', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getWalletTransactions('user-1');

    expect(response.data).toMatchObject({
      state: 'not_joined',
      transactions: [],
      reason: 'SEASON_NOT_JOINED',
    });
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
    expectNoWalletWrites(prisma);
  });

  it('returns filters object in not_joined response', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getWalletTransactions('user-1', {
      currency: 'KRW',
      direction: 'debit',
      txType: WalletTransactionType.fee,
    });

    expect(response.data).toMatchObject({
      state: 'not_joined',
      filters: {
        currency: CurrencyCode.KRW,
        direction: 'debit',
        txType: WalletTransactionType.fee,
      },
      transactions: [],
    });
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
    expectNoWalletWrites(prisma);
  });

  it('returns INVALID_DIRECTION for invalid direction', async () => {
    const { prisma, service } = createService();

    await expect(
      service.getWalletTransactions('user-1', { direction: 'in' }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
    expectNoWalletWrites(prisma);
  });

  it('returns INVALID_TX_TYPE for too long txType', async () => {
    const { prisma, service } = createService();

    await expect(
      service.getWalletTransactions('user-1', { txType: 'x'.repeat(65) }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
    expectNoWalletWrites(prisma);
  });

  it('rejects missing authenticated user for wallet transactions', async () => {
    const { service } = createService();

    await expect(
      service.getWalletTransactions(undefined),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
