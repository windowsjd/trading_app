jest.mock('../generated/prisma/client', () => {
  // Typed so the mocked module's Decimal is not an `any` leaking into every
  // fixture in the file.
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    BatchJobStatus: {
      pending: 'pending',
      running: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      skipped: 'skipped',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: { Decimal, JsonNull: null },
    PrismaClient: class PrismaClient {},
    SnapshotReason: {
      scheduled: 'scheduled',
      general_account_open: 'general_account_open',
      performance_baseline: 'performance_baseline',
      external_funding_before: 'external_funding_before',
      external_funding_after: 'external_funding_after',
    },
    TradingAccountMode: { season: 'season', general: 'general' },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
    WalletTransactionDirection: { credit: 'credit', debit: 'debit' },
    WalletTransactionReferenceType: {
      general_account_open: 'general_account_open',
      ad_reward_claim: 'ad_reward_claim',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      ad_reward: 'ad_reward',
    },
  };
});

import { HttpException, HttpStatus } from '@nestjs/common';
import type { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import type { PrismaService } from '../prisma/prisma.service';
import type { BatchService } from './batch.service';
import { GeneralDailySnapshotJobService } from './general-daily-snapshot-job.service';
import {
  GENERAL_DAILY_SNAPSHOT_JOB_NAME,
  type GeneralDailySnapshotJobInput,
  type GeneralDailySnapshotJobResult,
} from './general-daily-snapshot-job.types';

const SNAPSHOT_DATE = '2026-08-04';
const SNAPSHOT_DATE_UTC = new Date('2026-08-04T00:00:00.000Z');
const STARTED_AT = new Date('2026-08-04T00:00:30.000Z');

const account = (id: string, status: 'active' | 'suspended' = 'active') => ({
  id,
  userId: `user-of-${id}`,
  mode: 'general',
  status,
  initialCapitalKrw: { toFixed: () => '10000000.00000000' },
  seasonParticipant: null,
});

const WRITE_VALUES = {
  tradingAccountId: 'account-1',
  totalAssetKrw: '10050000.00000000',
  returnRate: '0.00000000',
  krwCash: '10050000.00000000',
  usdCashKrw: '0.00000000',
  domesticStockValueKrw: '0.00000000',
  usStockValueKrw: '0.00000000',
  cryptoValueKrw: '0.00000000',
  cumulativeExternalFundingKrw: '10050000.00000000',
  investmentPnlKrw: '0.00000000',
  timeWeightedReturnFactor: '1.000000000000000000',
};

const VALUATION = {
  assetValueKrw: '0.00000000',
  realizedPnlKrw: '0.00000000',
  unrealizedPnlKrw: '0.00000000',
};

/**
 * `expect.objectContaining` is typed `any`, which makes every assertion that
 * uses it an unsafe assignment. This narrows it once, here.
 */
function containing(shape: Record<string, unknown>): Record<string, unknown> {
  return expect.objectContaining(shape) as Record<string, unknown>;
}

/** First `data.capturedAt` a create mock was called with. */
function firstCapturedAt(create: jest.Mock): Date {
  const call = create.mock.calls[0] as [{ data: { capturedAt: Date } }];
  return call[0].data.capturedAt;
}

function createService() {
  const batchService = {
    runJob: jest.fn(
      async (params: {
        handler: (context: { startedAt: Date }) => Promise<unknown>;
      }) => {
        const result = await params.handler({ startedAt: STARTED_AT });
        return { success: true as const, data: { result } };
      },
    ),
  };

  const tx = {
    equitySnapshot: { create: jest.fn().mockResolvedValue({ id: 'equity-1' }) },
    dailyPortfolioSnapshot: {
      create: jest.fn().mockResolvedValue({ id: 'daily-1' }),
    },
    // The per-account `FOR UPDATE` lock (작업 6·7 보완 2). Returning a row means
    // "the account is still a general account"; a test that wants the
    // closed-race path overrides this with [].
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ id: 'locked', status: 'active' }]),
    tradingAccount: {
      // Re-read AFTER the lock, so the job never trusts the list it read at
      // the top of the run. By default it returns the same row the list did.
      findFirst: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(
          listedAccounts.find((row) => row.id === args.where.id) ?? null,
        ),
      ),
    },
  };

  let listedAccounts: Array<ReturnType<typeof account>> = [];

  const prisma = {
    tradingAccount: {
      findMany: jest.fn(() => Promise.resolve(listedAccounts)),
      count: jest.fn().mockResolvedValue(0),
    },
    dailyPortfolioSnapshot: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  // Keeps the post-lock re-read in step with whatever a test lists.
  prisma.tradingAccount.findMany.mockImplementation(() =>
    Promise.resolve(listedAccounts),
  );
  const setAccounts = (rows: Array<ReturnType<typeof account>>) => {
    listedAccounts = rows;
  };

  const performanceService = {
    buildOrdinarySnapshotValues: jest
      .fn()
      .mockResolvedValue({ values: WRITE_VALUES, valuation: VALUATION }),
  };

  const service = new GeneralDailySnapshotJobService(
    batchService as unknown as BatchService,
    prisma as unknown as PrismaService,
    performanceService as unknown as GeneralAccountPerformanceService,
  );

  return { service, batchService, prisma, performanceService, tx, setAccounts };
}

async function runAndGetResult(
  service: GeneralDailySnapshotJobService,
  input: GeneralDailySnapshotJobInput,
): Promise<GeneralDailySnapshotJobResult> {
  const response = (await service.run(input)) as unknown as {
    data: { result: GeneralDailySnapshotJobResult };
  };
  return response.data.result;
}

function structuredError(code: string): HttpException {
  return new HttpException(
    { success: false, error: { code, message: `${code} for test` } },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * 작업 7 보완 5. The job reuses BatchService, the season job's date parsing, and
 * the shared performance path; what is new — and what these tests pin down — is
 * account selection, per-account atomicity, and the dry-run report.
 */
describe('GeneralDailySnapshotJobService', () => {
  it('runs through BatchService with the date as its default business key', async () => {
    const { service, batchService } = createService();

    await service.run({ snapshotDate: SNAPSHOT_DATE, requestedBy: 'operator' });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: GENERAL_DAILY_SNAPSHOT_JOB_NAME,
        idempotencyKey: `${GENERAL_DAILY_SNAPSHOT_JOB_NAME}:${SNAPSHOT_DATE}`,
        dryRun: false,
        requestedBy: 'operator',
      }),
    );
  });

  it('selects active and suspended general accounts and excludes closed ones', async () => {
    const { service, prisma, setAccounts } = createService();
    setAccounts([
      account('account-1', 'active'),
      account('account-2', 'suspended'),
    ]);
    prisma.tradingAccount.count.mockResolvedValue(3);

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(prisma.tradingAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          mode: 'general',
          status: { in: ['active', 'suspended'] },
        },
      }),
    );
    // Closed accounts are counted for the report and never processed: no
    // valuation, no transaction, no write of any kind.
    expect(prisma.tradingAccount.count).toHaveBeenCalledWith({
      where: { mode: 'general', status: 'closed' },
    });
    expect(result.accounts).toMatchObject({
      total: 2,
      created: 2,
      excludedClosed: 3,
    });
  });

  it('writes the scheduled EquitySnapshot and the daily row in ONE transaction', async () => {
    const { service, prisma, tx, setAccounts } = createService();
    setAccounts([account('account-1')]);

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.equitySnapshot.create).toHaveBeenCalledWith({
      data: containing({
        seasonParticipantId: null,
        tradingAccountId: 'account-1',
        snapshotReason: 'scheduled',
        totalAssetKrw: WRITE_VALUES.totalAssetKrw,
        returnRate: WRITE_VALUES.returnRate,
        cumulativeExternalFundingKrw: WRITE_VALUES.cumulativeExternalFundingKrw,
        investmentPnlKrw: WRITE_VALUES.investmentPnlKrw,
        timeWeightedReturnFactor: WRITE_VALUES.timeWeightedReturnFactor,
        externalFundingReferenceId: null,
      }),
      select: { id: true },
    });
    expect(tx.dailyPortfolioSnapshot.create).toHaveBeenCalledWith({
      data: containing({
        seasonParticipantId: null,
        tradingAccountId: 'account-1',
        snapshotDate: SNAPSHOT_DATE_UTC,
        totalAssetKrw: WRITE_VALUES.totalAssetKrw,
        returnRate: WRITE_VALUES.returnRate,
        cumulativeExternalFundingKrw: WRITE_VALUES.cumulativeExternalFundingKrw,
        investmentPnlKrw: WRITE_VALUES.investmentPnlKrw,
        timeWeightedReturnFactor: WRITE_VALUES.timeWeightedReturnFactor,
      }),
      select: { id: true },
    });

    // capturedAt is deliberately NOT asserted above: it is decided AFTER this
    // account's row lock rather than taken from the batch clock (작업 6·7 보완
    // 2 §3.3). What matters is asserted directly below.
    //
    // ONE valuation instant per account: the scheduled EquitySnapshot and the
    // DailyPortfolioSnapshot beside it never disagree about when they were
    // taken, and neither is stamped with the batch's startedAt.
    const equityCapturedAt = firstCapturedAt(tx.equitySnapshot.create);
    const dailyCapturedAt = firstCapturedAt(tx.dailyPortfolioSnapshot.create);
    expect(dailyCapturedAt.getTime()).toBe(equityCapturedAt.getTime());
    expect(equityCapturedAt.getTime()).toBeGreaterThan(STARTED_AT.getTime());

    // The account row was locked BEFORE anything was computed or written.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.createdSnapshotIds).toEqual(['daily-1']);
    expect(result.createdEquitySnapshotIds).toEqual(['equity-1']);
  });

  it('skips an account that was closed after the run listed it, writing nothing', async () => {
    const { service, tx, setAccounts } = createService();
    setAccounts([account('account-1')]);
    // Closed between the list read and this account's turn: the lock still
    // finds the row (it is still a general account), but the post-lock re-read
    // reports it closed.
    tx.tradingAccount.findFirst.mockResolvedValueOnce({
      ...account('account-1'),
      status: 'closed',
    });

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(tx.equitySnapshot.create).not.toHaveBeenCalled();
    expect(tx.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(result.accounts).toMatchObject({
      created: 0,
      failed: 0,
      excludedClosed: 1,
      skippedClosedDuringRun: 1,
    });
    expect(result.createdSnapshotIds).toEqual([]);
    expect(result.createdEquitySnapshotIds).toEqual([]);
  });

  it('skips an account whose row disappeared from the general-account lock', async () => {
    const { service, tx, setAccounts } = createService();
    setAccounts([account('account-1')]);
    tx.$queryRaw.mockResolvedValueOnce([]);

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(tx.equitySnapshot.create).not.toHaveBeenCalled();
    expect(tx.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(result.accounts).toMatchObject({
      created: 0,
      excludedClosed: 1,
      skippedClosedDuringRun: 1,
    });
  });

  it('writes the daily row SECOND so a unique conflict rolls the equity row back', async () => {
    const { service, tx, setAccounts } = createService();
    setAccounts([account('account-1')]);
    const order: string[] = [];
    tx.equitySnapshot.create.mockImplementation(() => {
      order.push('equity');
      return Promise.resolve({ id: 'equity-1' });
    });
    tx.dailyPortfolioSnapshot.create.mockImplementation(() => {
      order.push('daily');
      return Promise.reject(
        Object.assign(new Error('conflict'), {
          code: 'P2002',
        }),
      );
    });

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(order).toEqual(['equity', 'daily']);
    // The loser reports the row as already existing and keeps nothing: the
    // rejection propagates out of the $transaction callback, so PostgreSQL
    // rolls the EquitySnapshot back with it.
    expect(result.accounts).toMatchObject({ created: 0, existing: 1 });
    expect(result.createdEquitySnapshotIds).toEqual([]);
  });

  it('skips an account that already has a row for the date', async () => {
    const { service, prisma, setAccounts } = createService();
    setAccounts([account('account-1')]);
    prisma.dailyPortfolioSnapshot.findUnique.mockResolvedValue({
      id: 'existing',
    });

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.accounts).toMatchObject({ existing: 1, created: 0 });
  });

  it('reports a dry run without opening a transaction or writing anything', async () => {
    const { service, prisma, setAccounts } = createService();
    setAccounts([account('account-1'), account('account-2', 'suspended')]);
    prisma.tradingAccount.count.mockResolvedValue(2);

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
      dryRun: true,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      createdSnapshotIds: [],
      createdEquitySnapshotIds: [],
      accounts: {
        total: 2,
        created: 0,
        wouldCreate: 2,
        existing: 0,
        failed: 0,
        integrityFailed: 0,
        valuationFailed: 0,
        excludedClosed: 2,
      },
    });
  });

  it('separates integrity failures from valuation failures', async () => {
    const { service, performanceService, setAccounts } = createService();
    setAccounts([
      account('account-1'),
      account('account-2'),
      account('account-3'),
    ]);
    performanceService.buildOrdinarySnapshotValues
      .mockRejectedValueOnce(structuredError('GENERAL_PERFORMANCE_INTEGRITY'))
      .mockRejectedValueOnce(
        new PortfolioValuationError('ASSET_PRICE_UNAVAILABLE', 'no price'),
      )
      .mockRejectedValueOnce(
        structuredError('GENERAL_PERFORMANCE_NOT_INITIALIZED'),
      );

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(result.accounts).toMatchObject({
      created: 0,
      failed: 3,
      integrityFailed: 2,
      valuationFailed: 1,
    });
    expect(result.errors.map((error) => error.code)).toEqual([
      'GENERAL_PERFORMANCE_INTEGRITY',
      'ASSET_PRICE_UNAVAILABLE',
      'GENERAL_PERFORMANCE_NOT_INITIALIZED',
    ]);
    // A failing account must not leave a partial or zeroed snapshot behind.
    expect(result.createdSnapshotIds).toEqual([]);
  });

  it('keeps going after one account fails', async () => {
    const { service, performanceService, setAccounts } = createService();
    setAccounts([account('account-1'), account('account-2')]);
    performanceService.buildOrdinarySnapshotValues.mockRejectedValueOnce(
      structuredError('GENERAL_ACCOUNT_INTEGRITY'),
    );

    const result = await runAndGetResult(service, {
      snapshotDate: SNAPSHOT_DATE,
    });

    expect(result.accounts).toMatchObject({ created: 1, failed: 1 });
  });

  it('rejects a snapshotDate that is not YYYY-MM-DD', async () => {
    const { service } = createService();

    await expect(service.run({ snapshotDate: '2026/08/04' })).rejects.toThrow(
      HttpException,
    );
    await expect(service.run({})).rejects.toThrow(HttpException);
  });
});
