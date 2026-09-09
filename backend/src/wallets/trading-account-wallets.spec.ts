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
      ad_reward: 'ad_reward',
    },
  };
});

import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { WalletsService } from './wallets.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as generalIntegrity from '../trading-accounts/general-account-integrity';

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../docs/fixtures/wallet-ledger.json'),
    'utf8',
  ),
);

const NOW = new Date('2026-08-03T00:00:00.000Z');

const createServices = (accountStatus = 'active') => {
  const prisma = {
    order: { findMany: jest.fn().mockResolvedValue([]) },
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

  it('scopes wallet transactions by the account and serializes canonical ids and metadata', async () => {
    const { prisma, service } = createServices();
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'wtx-1',
        currencyCode: 'KRW',
        direction: 'debit',
        txType: 'order_buy',
        referenceType: 'order',
        referenceId: 'order-1',
        amount: new Prisma.Decimal('1000000.00000000'),
        balanceAfter: new Prisma.Decimal('9000000.00000000'),
        occurredAt: NOW,
        createdAt: NOW,
      },
    ]);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'order-1',
        side: 'buy',
        status: 'executed',
        currencyCode: 'KRW',
        asset: { id: 'asset-1', name: '삼성전자', symbol: '005930' },
      },
    ]);

    const response = await service.getWalletTransactionsForTradingAccount(
      'user-1',
      'ta-1',
      { currency: 'KRW', direction: 'debit' },
    );

    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tradingAccountId: 'ta-1',
          currencyCode: 'KRW',
          direction: 'debit',
          AND: [{ txType: { not: 'initial_grant' } }, {}],
        }),
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    expect(response.data.transactions[0]).toMatchObject({
      id: 'wtx-1',
      amount: '1000000.00000000',
      balanceAfter: '9000000.00000000',
      asset: { id: 'asset-1', name: '삼성전자', symbol: '005930' },
      occurredAt: NOW.toISOString(),
    });
    expect(response.data.pagination.total).toBe(1);
  });
});

// Evaluate the read predicates against a small in-memory ledger, including the
// hidden audit row. This catches count/where/offset mistakes that canned pages
// cannot catch. It does not simulate PostgreSQL transactions or writer logic.
function ledgerServices(mode: 'general' | 'season' = 'season') {
  const h = createServices();
  if (mode === 'general') {
    h.accessService.getOwnedAccountOrThrow.mockResolvedValue({
      id: 'ta-1',
      userId: 'user-1',
      mode,
      status: 'active',
      seasonParticipant: null,
    } as never);
    jest
      .spyOn(generalIntegrity, 'assertGeneralAccountFinancialIntegrity')
      .mockResolvedValue();
  }
  const all = [
    ...fixture.krw.data.transactions,
    ...fixture.usd.data.transactions,
  ];
  const opening = {
    id: 'opening',
    currencyCode: 'KRW',
    direction: 'credit',
    txType: 'initial_grant',
    referenceType: mode === 'general' ? 'general_account_open' : 'season_join',
    referenceId: mode === 'general' ? 'ta-1' : 'sp-1',
    amount: '10000000.00000000',
    balanceAfter: '10000000.00000000',
    occurredAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
  const rows = [opening, ...all]
    .filter((row) => mode === 'general' || row.txType !== 'ad_reward')
    .map((row) => ({
      ...row,
      tradingAccountId: 'ta-1',
      amount: new Prisma.Decimal(row.amount),
      balanceAfter: new Prisma.Decimal(row.balanceAfter),
      occurredAt: new Date(row.occurredAt),
      createdAt: new Date(row.createdAt),
    }));
  const matches = (row, where) =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === 'AND')
        return value.every((condition) => matches(row, condition));
      if (value && typeof value === 'object') {
        if ('not' in value) return row[key] !== value.not;
        if ('in' in value) return value.in.includes(row[key]);
      }
      return row[key] === value;
    });
  h.prisma.walletTransaction.count.mockImplementation(
    async ({ where }) => rows.filter((row) => matches(row, where)).length,
  );
  h.prisma.walletTransaction.findMany.mockImplementation(
    async ({ where, skip, take }) =>
      rows
        .filter((row) => matches(row, where))
        .sort(
          (a, b) =>
            b.occurredAt.getTime() - a.occurredAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .slice(skip, skip + take),
  );
  h.prisma.order.findMany.mockImplementation(async ({ where }) =>
    all
      .filter((row) => row.asset && where.id.in.includes(row.referenceId))
      .map((row) => ({
        id: row.referenceId,
        side: row.txType === 'order_buy' ? 'buy' : 'sell',
        status: 'executed',
        currencyCode: row.currencyCode,
        asset: row.asset,
      })),
  );
  return { ...h, rows };
}

describe('user cash ledger read contract', () => {
  afterEach(() => jest.restoreAllMocks());

  it('serializes the exact fixture shared with frontend, without mutating financial rows', async () => {
    const h = ledgerServices('general');
    const before = JSON.stringify(h.rows);
    for (const currency of ['KRW', 'USD']) {
      const result = await h.service.getWalletTransactionsForTradingAccount(
        'user-1',
        'ta-1',
        { currency, limit: '20' },
      );
      expect(result).toEqual(fixture[currency.toLowerCase()]);
    }
    expect(JSON.stringify(h.rows)).toBe(before);
    expect(
      generalIntegrity.assertGeneralAccountFinancialIntegrity,
    ).toHaveBeenCalledTimes(2);
    expect(h.prisma.order.findMany).toHaveBeenCalledTimes(2);
    expect(h.prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tradingAccountId: 'ta-1',
          seasonParticipantId: null,
        }),
      }),
    );
  });

  it.each(['general', 'season'] as const)(
    'excludes only opening grants before count and pagination for %s',
    async (mode) => {
      const h = ledgerServices(mode);
      const ids: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const result = await h.service.getWalletTransactionsForTradingAccount(
          'user-1',
          'ta-1',
          { currency: 'KRW', limit: '1', offset: String(offset) },
        );
        expect(result.data.transactions).toHaveLength(1);
        expect(result.data.pagination.total).toBe(mode === 'general' ? 3 : 2);
        ids.push(result.data.transactions[0].id);
        offset = result.data.pagination.nextOffset;
      }
      expect(ids.at(-1)).toBe('wtx-buy');
      expect(ids).not.toContain('opening');
      expect(
        h.rows.find((row) => row.id === 'opening')!.balanceAfter.toFixed(8),
      ).toBe('10000000.00000000');
      const explicit = await h.service.getWalletTransactionsForTradingAccount(
        'user-1',
        'ta-1',
        { txType: 'initial_grant' },
      );
      expect(explicit.data.transactions).toEqual([]);
      expect(explicit.data.pagination).toMatchObject({
        total: 0,
        returned: 0,
        nextOffset: null,
      });
    },
  );

  it('filters canonical buy/sell, currency, direction and both exchange legs', async () => {
    const h = ledgerServices('general');
    for (const [currency, direction, txType, expected] of [
      ['KRW', 'debit', 'order_buy', 'wtx-buy'],
      ['USD', 'credit', 'order_sell', 'wtx-sell'],
      ['KRW', 'debit', 'exchange', 'wtx-fx-source'],
      ['USD', 'credit', 'exchange', 'wtx-fx-target'],
      ['KRW', 'credit', 'ad_reward', 'wtx-ad'],
    ]) {
      const result = await h.service.getWalletTransactionsForTradingAccount(
        'user-1',
        'ta-1',
        { currency, direction, txType },
      );
      expect(result.data.transactions.map((row) => row.id)).toEqual([expected]);
      expect(result.data.filters).toEqual({ currency, direction, txType });
    }
  });

  it('batch-loads multiple trade assets in one account-scoped query for market and limit ledger shapes', async () => {
    const h = ledgerServices();
    const result = await h.service.getWalletTransactionsForTradingAccount(
      'user-1',
      'ta-1',
    );
    expect(result.data.transactions.filter((row) => row.asset)).toHaveLength(2);
    expect(h.prisma.order.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tradingAccountId: 'ta-1',
          seasonParticipantId: 'sp-1',
          id: { in: expect.arrayContaining(['order-buy-1', 'order-sell-1']) },
        },
      }),
    );
  });

  it.each(['season_join', 'fx_execute', 'order', 'order_fill', 'nonsense'])(
    'rejects unsupported account filter %s before querying',
    async (txType) => {
      const h = ledgerServices();
      await expectStatusAndCode(
        h.service.getWalletTransactionsForTradingAccount('user-1', 'ta-1', {
          txType,
        }),
        400,
        'INVALID_TX_TYPE',
      );
      expect(h.prisma.walletTransaction.count).not.toHaveBeenCalled();
    },
  );

  it('fails closed for missing/foreign/mismatched order metadata instead of dropping a financial row', async () => {
    for (const override of [
      [],
      [
        {
          id: 'order-buy-1',
          side: 'sell',
          status: 'executed',
          currencyCode: 'KRW',
        },
      ],
    ]) {
      const h = ledgerServices();
      h.prisma.order.findMany.mockResolvedValueOnce(override);
      await expectStatusAndCode(
        h.service.getWalletTransactionsForTradingAccount('user-1', 'ta-1', {
          txType: 'order_buy',
        }),
        500,
        'TRADING_ACCOUNT_INTEGRITY',
      );
    }
  });

  it('runs the existing integrity gate before filtering even hidden audit rows', async () => {
    const h = ledgerServices();
    h.prisma.walletTransaction.findFirst.mockResolvedValueOnce({
      id: 'damaged-opening',
    } as never);
    await expectStatusAndCode(
      h.service.getWalletTransactionsForTradingAccount('user-1', 'ta-1'),
      500,
      'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    );
    expect(h.prisma.walletTransaction.count).not.toHaveBeenCalled();
    expect(h.prisma.walletTransaction.findMany).not.toHaveBeenCalled();
  });

  it('retains historical fee/adjustment/settlement rows without inventing writers or changing values', async () => {
    const h = ledgerServices();
    const base = h.rows.find((row) => row.id === 'opening')!;
    h.rows.push(
      ...['fee', 'adjustment', 'settlement'].map((txType) => ({
        ...base,
        id: txType,
        txType,
      })),
    );
    const result = await h.service.getWalletTransactionsForTradingAccount(
      'user-1',
      'ta-1',
      { currency: 'KRW' },
    );
    expect(result.data.transactions.map((row) => row.txType)).toEqual(
      expect.arrayContaining(['fee', 'adjustment', 'settlement']),
    );
  });
});
