jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
      general_account_open: 'general_account_open',
      performance_baseline: 'performance_baseline',
      external_funding_before: 'external_funding_before',
      external_funding_after: 'external_funding_after',
    },
    TradingAccountMode: { season: 'season', general: 'general' },
    WalletTransactionDirection: { credit: 'credit', debit: 'debit' },
    WalletTransactionReferenceType: {
      general_account_open: 'general_account_open',
      ad_reward_claim: 'ad_reward_claim',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      ad_reward: 'ad_reward',
    },
    Prisma: {
      Decimal,
      TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' },
    },
    PrismaClient: class PrismaClient {},
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { TradingAccountPortfolioService } from './trading-account-portfolio.service';
import { TradingAccountPortfolioController } from './trading-account-portfolio.controller';
import { PortfolioValuationError } from './portfolio-valuation.policy';
import { GlobalHttpExceptionFilter } from '../common/global-http-exception.filter';
import { adminDiagnosticRequestMiddleware } from '../common/admin-diagnostics';
import { assertDiagnosticTriage } from '../../scripts/lib/diagnostic-quality';

describe('portfolio HTTP failure boundaries', () => {
  it('reports inconsistent final ranking/snapshot evidence without current-price fallback', async () => {
    const account = {
      id: 'account-1',
      userId: 'user-1',
      mode: 'season',
      status: 'closed',
      seasonParticipant: {
        id: 'sp-1',
        season: { id: 'season-1', status: 'settled', endAt: new Date() },
      },
    };
    const client = {
      seasonRanking: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'rank-1',
          seasonId: 'season-1',
          seasonParticipantId: 'sp-1',
          tradingAccountId: account.id,
          totalAssetKrw: new Prisma.Decimal('100'),
          returnRate: new Prisma.Decimal('0'),
          capturedAt: new Date(),
          seasonParticipant: {
            id: 'sp-1',
            seasonId: 'season-1',
            userId: 'user-1',
            tradingAccountId: account.id,
            tradingAccount: {
              id: account.id,
              mode: 'season',
              userId: 'user-1',
            },
          },
        }),
      },
      equitySnapshot: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: 'snapshot-1',
            totalAssetKrw: new Prisma.Decimal('200'),
          }),
      },
    };
    const valuation = { calculateTradingAccountValuation: jest.fn() };
    const service = new TradingAccountPortfolioService(
      client as never,
      { getOwnedAccountOrThrow: jest.fn().mockResolvedValue(account) } as never,
      {} as never,
      valuation as never,
    );
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/trading-accounts/account-1/portfolio',
      headers: {},
      user: { userId: 'user-1', role: 'admin' },
    };
    const response = { setHeader: jest.fn() };
    const result = await new Promise<any>((resolve, reject) => {
      adminDiagnosticRequestMiddleware(
        request as never,
        response as never,
        () => {
          service.getPortfolio('user-1', account.id).then(
            () => reject(new Error('Expected integrity failure')),
            (error) => {
              const http = {
                status: jest.fn().mockReturnThis(),
                json: resolve,
              };
              new GlobalHttpExceptionFilter().catch(error, {
                switchToHttp: () => ({
                  getResponse: () => http,
                  getRequest: () => request,
                }),
              } as never);
            },
          );
        },
      );
    });
    assertDiagnosticTriage(
      result.error.diagnostic,
      'TRADING_ACCOUNT_INTEGRITY',
      'backend/src/portfolio/trading-account-portfolio.service.ts#getSettledPortfolio',
    );
    expect(valuation.calculateTradingAccountValuation).not.toHaveBeenCalled();
  });
  function portfolioHarness(mode: 'general' | 'season') {
    const account = {
      id: 'account-1',
      userId: 'user-1',
      mode,
      status: 'active',
      initialCapitalKrw: new Prisma.Decimal('10000000'),
      seasonParticipant:
        mode === 'season' ? { id: 'sp-1', season: { id: 'season-1' } } : null,
    };
    const access = {
      getOwnedAccountOrThrow: jest.fn().mockResolvedValue(account),
    };
    const valuation = { calculateTradingAccountValuation: jest.fn() };
    const performance = { resolveLivePerformance: jest.fn() };
    const client = {
      $transaction: jest.fn().mockImplementation((handler) => handler(client)),
    };
    const service = new TradingAccountPortfolioService(
      client as never,
      access as never,
      performance as never,
      valuation as never,
    );
    const controller = new TradingAccountPortfolioController(service);
    const fail = (error: unknown) =>
      (mode === 'season'
        ? valuation.calculateTradingAccountValuation
        : performance.resolveLivePerformance
      ).mockRejectedValue(error);
    const read = () =>
      controller.getPortfolio(
        { user: { userId: 'user-1' } } as never,
        account.id,
      );
    return { account, access, client, fail, read };
  }
  function httpFailure(error: unknown) {
    let body: any;
    const response = {
      status: jest.fn().mockReturnThis(),
      json: (value: unknown) => {
        body = value;
      },
    };
    new GlobalHttpExceptionFilter().catch(error, {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({}),
      }),
    } as never);
    return { status: response.status.mock.calls[0][0], body };
  }
  for (const mode of ['general', 'season'] as const) {
    it.each([
      'ASSET_PRICE_UNAVAILABLE',
      'ASSET_PRICE_STALE',
      'FX_RATE_UNAVAILABLE',
      'FX_RATE_STALE',
    ])(
      `${mode}: %s is a success envelope, not a failed request`,
      async (code) => {
        const h = portfolioHarness(mode);
        h.fail(new PortfolioValuationError(code, 'source unavailable'));
        expect(await h.read()).toMatchObject({
          success: true,
          data: {
            tradingAccountId: h.account.id,
            state: 'unavailable',
            summary: null,
            sectionErrors: [{ code }],
          },
        });
      },
    );
    it.each([
      'TRADING_ACCOUNT_SCOPE_MISMATCH',
      'CASH_WALLET_INVALID',
      'INVALID_INITIAL_CAPITAL',
      'POSITION_INVALID',
      'INVALID_DECIMAL',
    ])(
      `${mode}: %s retains its structural code through the HTTP filter`,
      async (code) => {
        const h = portfolioHarness(mode);
        h.fail(
          new PortfolioValuationError(
            code,
            'raw database/provider details must not be public',
          ),
        );
        const error = await h.read().then(
          () => {
            throw new Error('must fail closed');
          },
          (failure) => failure,
        );
        const result = httpFailure(error);
        expect(result).toMatchObject({
          status: 500,
          body: { success: false, error: { code } },
        });
        expect(JSON.stringify(result)).not.toContain('raw database/provider');
      },
    );
    it(`${mode}: unexpected DB/valuation exceptions remain failed HTTP requests`, async () => {
      const h = portfolioHarness(mode);
      h.fail(new Error('DB unavailable: internal details'));
      const error = await h.read().catch((failure) => failure);
      expect(httpFailure(error)).toEqual({
        status: 500,
        body: {
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Internal server error.',
          },
        },
      });
      if (mode === 'general')
        expect(h.client.$transaction).toHaveBeenCalledWith(
          expect.any(Function),
          { isolationLevel: 'RepeatableRead' },
        );
    });
    it(`${mode}: ownership 404 prevents valuation`, async () => {
      const h = portfolioHarness(mode);
      h.access.getOwnedAccountOrThrow.mockRejectedValue(
        new HttpException(
          {
            success: false,
            error: {
              code: 'TRADING_ACCOUNT_NOT_FOUND',
              message: 'Trading account not found',
            },
          },
          404,
        ),
      );
      expect(
        httpFailure(await h.read().catch((failure) => failure)),
      ).toMatchObject({
        status: 404,
        body: { error: { code: 'TRADING_ACCOUNT_NOT_FOUND' } },
      });
      expect(h.client.$transaction).not.toHaveBeenCalled();
    });
  }
  it('reuses admin request correlation and validation stage without exposing the domain exception message', async () => {
    const h = portfolioHarness('season');
    h.fail(
      new PortfolioValuationError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'private DB/provider/token values',
      ),
    );
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/trading-accounts/account-1/portfolio',
      headers: {},
      user: { userId: 'user-1', role: 'admin' },
    };
    const response = { setHeader: jest.fn() };
    const result = await new Promise<any>((resolve, reject) => {
      adminDiagnosticRequestMiddleware(
        request as never,
        response as never,
        () => {
          h.read().then(
            () => reject(new Error('must fail closed')),
            (error) => {
              let body: any;
              const http = {
                status: jest.fn().mockReturnThis(),
                json: (value) => {
                  body = value;
                },
              };
              new GlobalHttpExceptionFilter().catch(error, {
                switchToHttp: () => ({
                  getResponse: () => http,
                  getRequest: () => request,
                }),
              } as never);
              resolve(body);
            },
          );
        },
      );
    });
    expect(result.error.diagnostic).toMatchObject({
      domain: 'PORTFOLIO',
      failureStage: 'portfolio_valuation_validation',
      code: 'TRADING_ACCOUNT_SCOPE_MISMATCH',
    });
    expect(result.error.diagnostic.requestId).toBe(
      response.setHeader.mock.calls[0][1],
    );
    expect(JSON.stringify(result)).not.toContain('private DB/provider/token');
  });
});

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../docs/fixtures/home-daily-equity.json'),
    'utf8',
  ),
);
const d = (value: string) => new Prisma.Decimal(value);
function setup(mode: 'general' | 'season') {
  const account = {
    id: `${mode}-1`,
    mode,
    openedAt: new Date('2026-01-01T16:00:00Z'),
    seasonParticipant:
      mode === 'season' ? { id: 'sp-1', season: { status: 'active' } } : null,
  };
  const rows = fixture[mode].data.points.map((point, index) => ({
    id: `daily-${index}`,
    tradingAccountId: account.id,
    seasonParticipantId: account.seasonParticipant?.id ?? null,
    snapshotDate: new Date(point.snapshotDate),
    capturedAt: new Date(point.time),
    totalAssetKrw: d(point.totalAssetKrw),
    returnRate: d(point.returnRate),
    cumulativeExternalFundingKrw:
      point.cumulativeExternalFundingKrw === null
        ? null
        : d(point.cumulativeExternalFundingKrw),
    investmentPnlKrw: mode === 'general' ? d('0') : null,
    timeWeightedReturnFactor: mode === 'general' ? d('1') : null,
  }));
  const client = {
    dailyPortfolioSnapshot: { findMany: jest.fn().mockResolvedValue(rows) },
    equitySnapshot: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation((handler) => handler(client)),
  };
  const access = {
    getOwnedAccountOrThrow: jest.fn().mockResolvedValue(account),
  };
  const performance = {
    requireContinuousPerformanceState: jest.fn().mockResolvedValue({}),
  };
  const service = new TradingAccountPortfolioService(
    client as never,
    access as never,
    performance as never,
    {} as never,
  );
  return { account, rows, client, access, performance, service };
}

describe('account equity daily read contract and legacy ranges', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-08T15:00:01.000Z'));
  });
  afterEach(() => jest.useRealTimers());
  it.each(['general', 'season'] as const)(
    'serializes exact %s daily fixture, preserving canonical dates, amounts and returns',
    async (mode) => {
      const h = setup(mode);
      const before = JSON.stringify(h.rows);
      const response = await h.service.getEquity('user', h.account.id, {
        range: '30d',
        granularity: 'daily',
      });
      expect(response).toEqual({
        ...fixture[mode],
        data: {
          ...fixture[mode].data,
          points: fixture[mode].data.points.map((point) => ({
            ...point,
            futuresUnrealizedPnlUsd: null,
            futuresUnrealizedPnlKrw: null,
          })),
        },
      });
      expect(JSON.stringify(h.rows)).toBe(before);
      expect(h.client.dailyPortfolioSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            snapshotDate: {
              gte: new Date('2026-08-11'),
              lte: new Date('2026-09-09'),
            },
          }),
          orderBy: { snapshotDate: 'asc' },
        }),
      );
      expect(h.client.equitySnapshot.findMany).not.toHaveBeenCalled();
      if (mode === 'general') {
        expect(h.client.$transaction).toHaveBeenCalledWith(
          expect.any(Function),
          { isolationLevel: 'RepeatableRead' },
        );
        expect(h.access.getOwnedAccountOrThrow).toHaveBeenLastCalledWith(
          'user',
          h.account.id,
          h.client,
        );
        expect(
          h.performance.requireContinuousPerformanceState,
        ).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(['general', 'season'] as const)(
    'does not fill missing dates or replace empty %s history with intraday/current assets',
    async (mode) => {
      const h = setup(mode);
      h.client.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
        h.rows[0],
        h.rows[2],
      ]);
      const gap = await h.service.getEquity('user', h.account.id, {
        range: '30d',
        granularity: 'daily',
      });
      expect(gap.data.points.map((point) => point.snapshotDate)).toEqual([
        '2026-09-07',
        '2026-09-09',
      ]);
      h.client.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([]);
      const empty = await h.service.getEquity('user', h.account.id, {
        range: '30d',
        granularity: 'daily',
      });
      expect(empty.data).toMatchObject({ state: 'empty', points: [] });
      expect(h.client.equitySnapshot.findMany).not.toHaveBeenCalled();
    },
  );
  it.each(['general', 'season'] as const)(
    'rejects %s scope damage and duplicate canonical days',
    async (mode) => {
      for (const mutate of [
        (h) => {
          h.rows[0].tradingAccountId = 'other';
        },
        (h) => {
          h.rows[1].snapshotDate = h.rows[0].snapshotDate;
        },
      ]) {
        const h = setup(mode);
        mutate(h);
        await expect(
          h.service.getEquity('user', h.account.id, { granularity: 'daily' }),
        ).rejects.toBeInstanceOf(HttpException);
      }
    },
  );
  it('fails closed on general funding/performance corruption or uninitialized continuity', async () => {
    const h = setup('general');
    h.rows[0].investmentPnlKrw = null;
    await expect(
      h.service.getEquity('user', h.account.id, { granularity: 'daily' }),
    ).rejects.toBeInstanceOf(HttpException);
    h.performance.requireContinuousPerformanceState.mockRejectedValueOnce(
      new Error('no origin'),
    );
    await expect(
      h.service.getEquity('user', h.account.id, { granularity: 'daily' }),
    ).rejects.toThrow('no origin');
  });
  it('keeps default 1d intraday and general long-range fallback / season intraday sources', async () => {
    for (const mode of ['general', 'season'] as const)
      for (const range of ['1d', '7d', '30d', 'all']) {
        const h = setup(mode);
        h.client.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
        const response = await h.service.getEquity('user', h.account.id, {
          range,
        });
        expect(response.data).not.toHaveProperty('granularity');
        expect(h.client.equitySnapshot.findMany).toHaveBeenCalledTimes(1);
        expect(h.client.dailyPortfolioSnapshot.findMany).toHaveBeenCalledTimes(
          mode === 'general' && range !== '1d' ? 1 : 0,
        );
      }
  });
  it('validates auth, ownership and invalid granularity before reading history', async () => {
    const h = setup('season');
    await expect(
      h.service.getEquity(undefined, h.account.id),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      h.service.getEquity('user', h.account.id, { granularity: 'hourly' }),
    ).rejects.toBeInstanceOf(HttpException);
    h.access.getOwnedAccountOrThrow.mockRejectedValueOnce(
      new HttpException('not found', 404),
    );
    await expect(
      h.service.getEquity('user', 'foreign', { granularity: 'daily' }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(h.client.dailyPortfolioSnapshot.findMany).not.toHaveBeenCalled();
  });
});

describe('canonical daily date range boundaries', () => {
  afterEach(() => jest.useRealTimers());
  it.each(['general', 'season'] as const)(
    'uses KST date rollover and canonical keys for %s, even with delayed capture',
    async (mode) => {
      jest.useFakeTimers();
      for (const [now, end] of [
        ['2026-09-08T14:59:59.999Z', '2026-09-08'],
        ['2026-09-08T15:00:00.000Z', '2026-09-09'],
      ]) {
        jest.setSystemTime(new Date(now));
        const h = setup(mode);
        await h.service.getEquity('user', h.account.id, {
          range: '1d',
          granularity: 'daily',
        });
        expect(h.client.dailyPortfolioSnapshot.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              snapshotDate: { gte: new Date(end), lte: new Date(end) },
            }),
          }),
        );
        await h.service.getEquity('user', h.account.id, {
          range: 'all',
          granularity: 'daily',
        });
        expect(
          h.client.dailyPortfolioSnapshot.findMany,
        ).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              snapshotDate: { gte: new Date('2026-01-02'), lte: new Date(end) },
            }),
          }),
        );
      }
    },
  );
});

describe('extended Home calendar ranges', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-01T15:00:01Z'));
  });
  afterEach(() => jest.useRealTimers());
  it.each(['general', 'season'] as const)(
    '%s selects only actual rows across every calendar range',
    async (mode) => {
      for (const days of [7, 30, 90, 180, 360]) {
        const h = setup(mode);
        const end = new Date('2026-10-02T00:00:00Z');
        const start = new Date(end.getTime() - (days - 1) * 86400000);
        // 200 calendar dates of account history with real missing days.
        const history = Array.from({ length: 200 }, (_, i) => ({
          ...h.rows[0],
          id: `d${i}`,
          snapshotDate: new Date(end.getTime() - i * 86400000),
        }))
          .filter((_, i) => i !== 2 && i !== 3)
          .reverse();
        h.client.dailyPortfolioSnapshot.findMany.mockImplementation(
          async ({ where }) =>
            history.filter(
              (r) =>
                r.snapshotDate >= where.snapshotDate.gte &&
                r.snapshotDate <= where.snapshotDate.lte,
            ),
        );
        const response = await h.service.getEquity('user', h.account.id, {
          range: `${days}d`,
          granularity: 'daily',
        });
        expect(response.data.range).toBe(`${days}d`);
        expect(response.data.points.map((p) => p.snapshotDate)).toEqual(
          history
            .filter((r) => r.snapshotDate >= start)
            .map((r) => r.snapshotDate.toISOString().slice(0, 10)),
        );
        expect(
          h.client.dailyPortfolioSnapshot.findMany.mock.calls[0][0].where
            .snapshotDate,
        ).toEqual({ gte: start, lte: end });
        expect(h.client.equitySnapshot.findMany).not.toHaveBeenCalled();
      }
    },
  );
  it('returns all 23 actual days for a younger account in a 90-day range', async () => {
    const h = setup('season');
    h.client.dailyPortfolioSnapshot.findMany.mockResolvedValue(
      Array.from({ length: 23 }, (_, i) => ({
        ...h.rows[0],
        snapshotDate: new Date(Date.UTC(2026, 8, 10 + i)),
      })),
    );
    expect(
      (
        await h.service.getEquity('user', h.account.id, {
          range: '90d',
          granularity: 'daily',
        })
      ).data.points,
    ).toHaveLength(23);
  });
});
