jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    FxExecuteRequestStatus: {
      pending: 'pending',
      succeeded: 'succeeded',
      failed: 'failed',
    },
    QuoteStatus: {
      active: 'active',
      consumed: 'consumed',
      expired: 'expired',
      canceled: 'canceled',
    },
    QuoteType: {
      fx: 'fx',
      order: 'order',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
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
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      season_join: 'season_join',
      exchange_transaction: 'exchange_transaction',
      order: 'order',
      manual_adjustment: 'manual_adjustment',
      settlement: 'settlement',
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
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { FxService } from './fx.service';

const NOW = new Date('2026-08-03T00:00:00.000Z');

const ownedAccount = (overrides: Record<string, unknown> = {}) => ({
  id: 'ta-1',
  userId: 'user-1',
  mode: 'season',
  status: 'active',
  seasonParticipant: {
    id: 'sp-1',
    userId: 'user-1',
    participantStatus: 'active',
    joinedAt: NOW,
    season: {
      id: 'season-1',
      name: 'Season 1',
      status: 'active',
      startAt: new Date('2026-07-01T00:00:00.000Z'),
      endAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  },
  ...overrides,
});

const createServices = () => {
  const prisma = {
    season: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'season-1',
        name: 'Season 1',
        status: 'active',
        startAt: new Date('2026-07-01T00:00:00.000Z'),
        endAt: new Date('2026-09-01T00:00:00.000Z'),
        fxFeeRate: new Prisma.Decimal('0.001000'),
      }),
    },
    exchangeTransaction: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // Financial scope-integrity probes (getExchangesForTradingAccount runs
    // them before listing): null means the participant has no anomalous rows.
    cashWallet: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    walletTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    fxExecuteRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const accessService = {
    getOwnedAccountOrThrow: jest.fn().mockResolvedValue(ownedAccount()),
  };
  const service = new FxService(
    prisma as never,
    undefined,
    undefined,
    accessService as never,
  );

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

const QUOTE_BODY = {
  fromCurrency: 'KRW',
  toCurrency: 'USD',
  sourceAmount: '1000.00000000',
};

describe('FxService account-scoped gating', () => {
  it('rejects a missing user with 401 before ownership lookup', async () => {
    const { accessService, service } = createServices();

    await expectStatusAndCode(
      service.quoteForTradingAccount(undefined, 'ta-1', QUOTE_BODY),
      401,
      'UNAUTHORIZED',
    );
    expect(accessService.getOwnedAccountOrThrow).not.toHaveBeenCalled();
  });

  it('propagates the shared 404 for foreign/missing accounts', async () => {
    const { accessService, service } = createServices();
    accessService.getOwnedAccountOrThrow.mockRejectedValue(
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
      service.quoteForTradingAccount('user-1', 'ta-other', QUOTE_BODY),
      404,
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    await expectStatusAndCode(
      service.getExchangesForTradingAccount('user-1', 'ta-other'),
      404,
      'TRADING_ACCOUNT_NOT_FOUND',
    );
  });

  it('blocks general accounts with a structured not-implemented error', async () => {
    const { accessService, service } = createServices();
    accessService.getOwnedAccountOrThrow.mockResolvedValue(
      ownedAccount({ mode: 'general', seasonParticipant: null }),
    );

    await expectStatusAndCode(
      service.quoteForTradingAccount('user-1', 'ta-1', QUOTE_BODY),
      409,
      'GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED',
    );
  });

  it.each(['suspended', 'closed'])(
    'blocks asset mutation on a %s account',
    async (status) => {
      const { accessService, service } = createServices();
      accessService.getOwnedAccountOrThrow.mockResolvedValue(
        ownedAccount({ status }),
      );

      await expectStatusAndCode(
        service.quoteForTradingAccount('user-1', 'ta-1', QUOTE_BODY),
        409,
        'TRADING_ACCOUNT_NOT_ACTIVE',
      );
    },
  );

  it('keeps exchange history readable for suspended and closed accounts', async () => {
    for (const status of ['suspended', 'closed']) {
      const { accessService, prisma, service } = createServices();
      accessService.getOwnedAccountOrThrow.mockResolvedValue(
        ownedAccount({ status }),
      );

      const response = await service.getExchangesForTradingAccount(
        'user-1',
        'ta-1',
      );

      expect(response.data.tradingAccountId).toBe('ta-1');
      expect(response.data.exchanges).toEqual([]);
      expect(prisma.exchangeTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tradingAccountId: 'ta-1' },
        }),
      );
    }
  });
});
