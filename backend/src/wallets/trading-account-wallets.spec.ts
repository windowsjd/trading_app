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
      excluded: 'excluded',
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
    TradingAccountMode: {
      season: 'season',
      general: 'general',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
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

import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { WalletsService } from './wallets.service';

const NOW = new Date('2026-08-03T00:00:00.000Z');

const createServices = (accountStatus = 'active') => {
  const prisma = {
    cashWallet: {
      findMany: jest.fn().mockResolvedValue([]),
      // Scope-integrity probe (assertSeasonAccountFinancialScopeIntegrity):
      // null = no anomalous rows, so the healthy account reads proceed.
      findFirst: jest.fn().mockResolvedValue(null),
    },
    walletTransaction: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    exchangeTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    fxExecuteRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const accessService = {
    getOwnedAccountOrThrow: jest.fn().mockResolvedValue({
      id: 'ta-1',
      userId: 'user-1',
      mode: 'season',
      status: accountStatus,
      seasonParticipant: { id: 'sp-1', userId: 'user-1' },
    }),
  };
  const service = new WalletsService(prisma as never, accessService as never);

  return { prisma, accessService, service };
};

const expectStatusAndCode = async (
  work: Promise<unknown>,
  status: number,
  code: string,
) => {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpException);
  expect((caught as HttpException).getStatus()).toBe(status);
  expect(
    ((caught as HttpException).getResponse() as { error: { code: string } })
      .error.code,
  ).toBe(code);
};

describe('WalletsService account-scoped reads', () => {
  it('rejects a missing user id with 401 before ownership lookup', async () => {
    const { accessService, service } = createServices();

    await expectStatusAndCode(
      service.getWalletsForTradingAccount(undefined, 'ta-1'),
      401,
      'UNAUTHORIZED',
    );
    expect(accessService.getOwnedAccountOrThrow).not.toHaveBeenCalled();
  });

  it('propagates the shared 404 for foreign/missing accounts', async () => {
    const { accessService, service } = createServices();
    accessService.getOwnedAccountOrThrow.mockRejectedValueOnce(
      new HttpException(
        {
          success: false,
          error: {
            code: 'TRADING_ACCOUNT_NOT_FOUND',
            message: 'Trading account not found',
          },
        },
        HttpStatus.NOT_FOUND,
      ),
    );

    await expectStatusAndCode(
      service.getWalletsForTradingAccount('user-1', 'ta-other'),
      404,
      'TRADING_ACCOUNT_NOT_FOUND',
    );
  });

  it('queries wallets by the account scope and serializes like the legacy API', async () => {
    const { prisma, service } = createServices();
    prisma.cashWallet.findMany.mockResolvedValueOnce([
      {
        currencyCode: 'KRW',
        balanceAmount: new Prisma.Decimal('10000000.00000000'),
        reservedAmount: new Prisma.Decimal('250000.00000000'),
        updatedAt: NOW,
      },
    ]);

    const response = await service.getWalletsForTradingAccount(
      'user-1',
      ' ta-1 ',
    );

    expect(prisma.cashWallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tradingAccountId: 'ta-1' },
      }),
    );
    expect(response.data).toEqual({
      tradingAccountId: 'ta-1',
      wallets: [
        {
          currencyCode: 'KRW',
          balanceAmount: '10000000.00000000',
          reservedAmount: '250000.00000000',
          availableAmount: '9750000.00000000',
          updatedAt: NOW.toISOString(),
        },
      ],
      summary: {
        totalWallets: 1,
        hasKrwWallet: true,
        hasUsdWallet: false,
      },
    });
  });

  it('reads suspended and closed accounts (reads are never status-gated) without creating wallets', async () => {
    for (const status of ['suspended', 'closed']) {
      const { prisma, service } = createServices(status);

      const response = await service.getWalletsForTradingAccount(
        'user-1',
        'ta-1',
      );

      expect(response.data.wallets).toEqual([]);
      expect(response.data.summary.totalWallets).toBe(0);
      // A GET never creates wallets/accounts.
      expect(prisma.cashWallet.findMany).toHaveBeenCalledTimes(1);
    }
  });

  it('scopes wallet transactions by the account and keeps legacy filters', async () => {
    const { prisma, service } = createServices();
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'wtx-1',
        currencyCode: 'KRW',
        direction: 'credit',
        txType: 'initial_grant',
        referenceType: 'season_join',
        referenceId: 'sp-1',
        amount: new Prisma.Decimal('10000000.00000000'),
        balanceAfter: new Prisma.Decimal('10000000.00000000'),
        occurredAt: NOW,
        createdAt: NOW,
      },
    ]);

    const response = await service.getWalletTransactionsForTradingAccount(
      'user-1',
      'ta-1',
      { currency: 'KRW', direction: 'credit' },
    );

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tradingAccountId: 'ta-1',
          currencyCode: 'KRW',
          direction: 'credit',
        }),
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    expect(response.data.transactions[0]).toMatchObject({
      id: 'wtx-1',
      amount: '10000000.00000000',
      balanceAfter: '10000000.00000000',
      occurredAt: NOW.toISOString(),
    });
    expect(response.data.pagination.total).toBe(1);
  });
});
