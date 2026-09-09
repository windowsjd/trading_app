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
    seasonParticipant: mode === 'season' ? { id: 'sp-1' } : null,
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
      expect(response).toEqual(fixture[mode]);
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
          h.rows[0].seasonParticipantId = 'other';
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
