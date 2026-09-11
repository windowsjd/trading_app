jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

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
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
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
      JsonNull: null,
    },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    TradingAccountMode: {
      general: 'general',
      season: 'season',
    },
  };
});

import { HttpStatus } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import {
  DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME,
  DailyPortfolioSnapshotJobResult,
} from './daily-portfolio-snapshot-job.types';
import { DailyPortfolioSnapshotJobService } from './daily-portfolio-snapshot-job.service';

type BatchServiceMock = {
  runJob: jest.Mock;
};

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('DailyPortfolioSnapshotJobService', () => {
  const startedAt = new Date('2026-05-20T00:00:30.000Z');
  const snapshotDate = '2026-05-20';

  it.each([
    [600, 120, true],
    [7201, 120, false],
    [600, 301, false],
  ])(
    'values and writes daily history with FX age %s and asset age %s (success=%s)',
    async (fxAge, assetAge, succeeds) => {
      const { service, prisma } = createServiceWithRealValuation();
      mockSeason(prisma, SeasonStatus.active);
      mockParticipants(prisma, [{ id: 'sp-usd', userId: 'user-usd' }]);
      prisma.tradingAccount.findUnique.mockResolvedValue(
        participantDetail({
          id: 'sp-usd',
          krwCash: '1000',
          usdCash: '10',
          positions: [
            positionDetail({
              assetId: 'crypto-usd',
              assetType: AssetType.crypto,
              currencyCode: CurrencyCode.USD,
            }),
          ],
        }),
      );
      const fxAt = new Date(startedAt.getTime() - fxAge * 1000);
      const priceAt = new Date(startedAt.getTime() - assetAge * 1000);
      prisma.fxRateSnapshot.findMany.mockResolvedValue([
        {
          id: 'display-fx',
          baseCurrency: CurrencyCode.USD,
          quoteCurrency: CurrencyCode.KRW,
          rate: new Prisma.Decimal('1390'),
          sourceType: FxRateSourceType.provider_api,
          sourceName: 'korea_exim_exchange_rate',
          effectiveAt: fxAt,
          capturedAt: fxAt,
          createdAt: fxAt,
        },
      ]);
      prisma.assetPriceSnapshot.findMany.mockResolvedValue([
        {
          id: 'display-crypto',
          assetId: 'crypto-usd',
          currencyCode: CurrencyCode.USD,
          price: new Prisma.Decimal('100'),
          sourceType: AssetPriceSourceType.provider_api,
          sourceName: 'binance_spot_ws_ticker',
          effectiveAt: priceAt,
          capturedAt: priceAt,
          createdAt: priceAt,
        },
      ]);
      prisma.fxRateSnapshot.findFirst.mockResolvedValue(null);
      prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);
      prisma.dailyPortfolioSnapshot.create.mockResolvedValue({
        id: 'daily-display',
      });
      const result = await runAndGetResult(service, {
        seasonId: 'season-1',
        snapshotDate,
      });
      if (succeeds) {
        expect(result.participants).toMatchObject({ created: 1, failed: 0 });
        expect(result.sourceSummary).toMatchObject({
          providerApiUsed: true,
          fallbackUsed: false,
        });
        expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            totalAssetKrw: '153900.00000000',
            usdCashKrw: '13900.00000000',
            assetValueKrw: '139000.00000000',
            snapshotDate: new Date(`${snapshotDate}T00:00:00.000Z`),
            capturedAt: startedAt,
          }),
          select: { id: true },
        });
      } else {
        expect(result.participants).toMatchObject({ created: 0, failed: 1 });
        expect(result.errors).toMatchObject([
          {
            code:
              fxAge > 7200 ? 'FX_RATE_UNAVAILABLE' : 'ASSET_PRICE_UNAVAILABLE',
          },
        ]);
        expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
      }
    },
  );

  it('writes KRW-only daily history without reading any FX snapshot', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-krw', userId: 'user-krw' }]);
    prisma.tradingAccount.findUnique.mockResolvedValue(
      participantDetail({ id: 'sp-krw', usdCash: '0', positions: [] }),
    );
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'daily-krw' });
    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });
    expect(result.participants).toMatchObject({ created: 1, failed: 0 });
    expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('bulk checks 100 participants once and values only the missing participant', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    const participants = Array.from({ length: 100 }, (_, i) => ({
      id: `sp-${i}`,
      userId: `user-${i}`,
    }));
    mockParticipants(prisma, participants);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue(
      participants.slice(0, 99).map(({ id }) => ({
        tradingAccountId: `account-of-${id}`,
      })),
    );
    valuationService.calculateTradingAccountValuation.mockResolvedValue(
      valuation('sp-99'),
    );
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snap-99' });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.dailyPortfolioSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.dailyPortfolioSnapshot.findMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: {
          in: participants.map(({ id }) => `account-of-${id}`),
        },
        snapshotDate: new Date(`${snapshotDate}T00:00:00.000Z`),
      },
      select: { tradingAccountId: true },
    });
    expect(prisma.dailyPortfolioSnapshot.findUnique).not.toHaveBeenCalled();
    expect(
      valuationService.calculateTradingAccountValuation,
    ).toHaveBeenCalledTimes(1);
    expect(
      valuationService.calculateTradingAccountValuation,
    ).toHaveBeenCalledWith(
      'account-of-sp-99',
      startedAt,
      'daily_portfolio_snapshot',
    );
    expect(result.participants).toMatchObject({
      total: 100,
      existing: 99,
      created: 1,
    });
  });

  it('counts a concurrent create after the bulk read as existing on P2002', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    valuationService.calculateTradingAccountValuation.mockResolvedValue(
      valuation('sp-1'),
    );
    prisma.dailyPortfolioSnapshot.create.mockRejectedValue(
      Object.assign(new Error('concurrent winner'), { code: 'P2002' }),
    );
    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });
    expect(prisma.dailyPortfolioSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.dailyPortfolioSnapshot.findUnique).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledTimes(1);
    expect(result.participants).toMatchObject({
      created: 0,
      existing: 1,
      failed: 0,
    });
    expect(result.createdSnapshotIds).toEqual([]);
  });

  it('retries only the failed participant on the next same-day attempt', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-A', userId: 'user-A' },
      { id: 'sp-B', userId: 'user-B' },
    ]);
    valuationService.calculateTradingAccountValuation
      .mockResolvedValueOnce(valuation('sp-A'))
      .mockRejectedValueOnce(
        new PortfolioValuationError(
          'ASSET_PRICE_UNAVAILABLE',
          'temporary failure',
        ),
      )
      .mockResolvedValueOnce(valuation('sp-B'));
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snapshot' });
    const first = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      idempotencyKey: 'attempt-1',
    });
    expect(first.participants).toMatchObject({ created: 1, failed: 1 });
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      { tradingAccountId: 'account-of-sp-A' },
    ]);
    const second = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      idempotencyKey: 'attempt-2',
    });
    expect(second.participants).toMatchObject({
      created: 1,
      existing: 1,
      failed: 0,
    });
    expect(
      valuationService.calculateTradingAccountValuation.mock.calls.map(
        ([id]) => id,
      ),
    ).toEqual(['account-of-sp-A', 'account-of-sp-B', 'account-of-sp-B']);
    expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledTimes(2);
  });

  it('uses the actual scheduled capture time and defers remaining participants at local midnight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-20T14:59:59.000Z'));
    try {
      const { service, prisma, valuationService } = createService();
      mockSeason(prisma, SeasonStatus.active);
      mockParticipants(prisma, [
        { id: 'sp-1', userId: 'user-1' },
        { id: 'sp-2', userId: 'user-2' },
      ]);
      prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
      valuationService.calculateTradingAccountValuation.mockResolvedValue(
        valuation('sp-1'),
      );
      prisma.dailyPortfolioSnapshot.create.mockImplementationOnce(() => {
        jest.setSystemTime(new Date('2026-05-20T15:00:00.000Z'));
        return Promise.resolve({ id: 'snap-1' });
      });
      const result = await runAndGetResult(service, {
        seasonId: 'season-1',
        snapshotDate,
        snapshotTimezone: 'Asia/Seoul',
      });
      expect(result.participants).toMatchObject({ created: 1, skipped: 1 });
      expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledTimes(1);
      expect(
        valuationService.calculateTradingAccountValuation,
      ).toHaveBeenCalledWith(
        'account-of-sp-1',
        new Date('2026-05-20T14:59:59.000Z'),
        'daily_portfolio_snapshot',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('fills a later participant on rerun without overwriting existing same-day rows', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    valuationService.calculateTradingAccountValuation.mockImplementation(
      (id: string) =>
        Promise.resolve(valuation(id.replace(/^account-of-/, ''))),
    );
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snap' });
    await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      idempotencyKey: 'tick-1',
    });
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      { tradingAccountId: 'account-of-sp-1' },
    ]);
    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      idempotencyKey: 'tick-2',
    });
    expect(result.participants).toMatchObject({ existing: 1, created: 1 });
    expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledTimes(2);
    expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        seasonParticipantId: 'sp-2',
        tradingAccountId: 'account-of-sp-2',
      }),
      select: { id: true },
    });
  });

  it('uses BatchService.runJob with the fixed jobName and generated idempotencyKey', async () => {
    const { service, batchService, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    valuationService.calculateTradingAccountValuation.mockResolvedValue(
      valuation('sp-1'),
    );
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snap-1' });

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
      requestedBy: 'operator',
    });

    expect(
      valuationService.calculateTradingAccountValuation,
    ).toHaveBeenCalledWith(
      'account-of-sp-1',
      startedAt,
      'daily_portfolio_snapshot',
    );
    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME,
        idempotencyKey: 'daily-portfolio-snapshot:season-1:2026-05-20',
        dryRun: false,
        requestedBy: 'operator',
      }),
    );
  });

  it('returns wouldCreate in dry-run without creating daily portfolio snapshots', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    valuationService.calculateTradingAccountValuation.mockResolvedValue(
      valuation('sp-1'),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
    });

    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      participants: {
        total: 1,
        created: 0,
        wouldCreate: 1,
        existing: 0,
        failed: 0,
        skipped: 0,
      },
      createdSnapshotIds: [],
      sourceSummary: {
        participantsUsingProviderApi: 0,
        participantsUsingAdminManual: 0,
        participantsUsingFallback: 0,
        providerApiUsed: false,
        adminManualUsed: false,
        fallbackUsed: false,
      },
    });
  });

  it('creates snapshots for valuation-available active participants', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    valuationService.calculateTradingAccountValuation.mockResolvedValue(
      valuation('sp-1'),
    );
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snap-1' });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonId: 'season-1',
          participantStatus: ParticipantStatus.active,
        },
      }),
    );
    expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        seasonParticipantId: 'sp-1',
        snapshotDate: new Date('2026-05-20T00:00:00.000Z'),
        totalAssetKrw: '1200000.00000000',
        krwCash: '900000.00000000',
        usdCashKrw: '140000.00000000',
        assetValueKrw: '160000.00000000',
        returnRate: '20.00000000',
        capturedAt: startedAt,
      }),
      select: {
        id: true,
      },
    });
    expect(result.participants.created).toBe(1);
    expect(result.createdSnapshotIds).toEqual(['snap-1']);
    expect(
      valuationService.calculateTradingAccountValuation,
    ).toHaveBeenCalledWith(
      'account-of-sp-1',
      startedAt,
      'daily_portfolio_snapshot',
    );
  });

  it('classifies an existing snapshot without overwriting it', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([
      { tradingAccountId: 'account-of-sp-1' },
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(
      valuationService.calculateTradingAccountValuation,
    ).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(result.participants).toMatchObject({
      total: 1,
      created: 0,
      existing: 1,
      failed: 0,
    });
  });

  it('records participant valuation failure without failing the whole job', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-fail', userId: 'user-fail' },
      { id: 'sp-ok', userId: 'user-ok' },
    ]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    valuationService.calculateTradingAccountValuation
      .mockRejectedValueOnce(
        new PortfolioValuationError(
          'ASSET_PRICE_UNAVAILABLE',
          'Asset price snapshot is unavailable.',
        ),
      )
      .mockResolvedValueOnce(valuation('sp-ok'));
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snap-ok' });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(result.participants).toMatchObject({
      total: 2,
      created: 1,
      failed: 1,
    });
    expect(result.errors).toEqual([
      {
        seasonParticipantId: 'sp-fail',
        userId: 'user-fail',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable.',
      },
    ]);
  });

  it('succeeds at job level even when every participant valuation fails', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    valuationService.calculateTradingAccountValuation.mockRejectedValue(
      new PortfolioValuationError(
        'FX_RATE_STALE',
        'USD/KRW FX rate snapshot is stale.',
      ),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(result.participants).toMatchObject({
      total: 2,
      created: 0,
      failed: 2,
    });
    expect(result.errors).toHaveLength(2);
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
  });

  it('treats missing season as a job-level error inside the batch envelope', async () => {
    const { service, batchService, prisma } = createService();
    prisma.season.findUnique.mockResolvedValue(null);

    await expect(
      service.run({
        seasonId: 'missing-season',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(batchService.runJob).toHaveBeenCalled();
  });

  it('rejects upcoming seasons at job level', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.upcoming);

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejects settled seasons at job level', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejects invalid snapshotDate as BAD_REQUEST', async () => {
    const { service } = createService();

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate: '2026-02-31',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('returns success with zero counts when there are no active participants', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, []);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(result.participants).toEqual({
      total: 0,
      created: 0,
      wouldCreate: 0,
      existing: 0,
      failed: 0,
      skipped: 0,
    });
  });

  it('requires fresh approved admin_manual USD/KRW for USD cash valuation', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-usd', userId: 'user-usd' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    prisma.tradingAccount.findUnique.mockResolvedValue(
      participantDetail({
        id: 'sp-usd',
        krwCash: '0.00000000',
        usdCash: '10.00000000',
        positions: [],
      }),
    );
    prisma.fxRateSnapshot.findFirst.mockResolvedValue(null);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceType: FxRateSourceType.admin_manual,
          approvedByUserId: {
            not: null,
          },
        }),
      }),
    );
    expect(result.errors).toMatchObject([
      {
        seasonParticipantId: 'sp-usd',
        code: 'FX_RATE_UNAVAILABLE',
      },
    ]);
  });

  it('classifies stale FX as participant failure without snapshot creation', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-usd', userId: 'user-usd' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    prisma.tradingAccount.findUnique.mockResolvedValue(
      participantDetail({
        id: 'sp-usd',
        krwCash: '0.00000000',
        usdCash: '10.00000000',
        positions: [],
      }),
    );
    prisma.fxRateSnapshot.findFirst.mockResolvedValue({
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: new Prisma.Decimal('1400.00000000'),
      sourceType: FxRateSourceType.admin_manual,
      effectiveAt: new Date('2026-05-19T23:59:29.999Z'),
      capturedAt: new Date('2026-05-19T23:59:30.000Z'),
      createdAt: new Date('2026-05-19T23:59:30.000Z'),
      approvedByUserId: 'operator',
    });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(result.errors).toMatchObject([
      {
        code: 'FX_RATE_STALE',
      },
    ]);
  });

  it('classifies missing asset price as participant failure', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-asset', userId: 'user-asset' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    prisma.tradingAccount.findUnique.mockResolvedValue(
      participantDetail({
        id: 'sp-asset',
        positions: [
          positionDetail({
            assetId: 'asset-krw',
            assetType: AssetType.domestic_stock,
            currencyCode: CurrencyCode.KRW,
          }),
        ],
      }),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(result.errors).toMatchObject([
      {
        code: 'ASSET_PRICE_UNAVAILABLE',
      },
    ]);
  });

  it('uses provider_api valuation in dry-run and reports source summary', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-provider', userId: 'user-provider' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    prisma.tradingAccount.findUnique.mockResolvedValueOnce(
      participantDetail({
        id: 'sp-provider',
        positions: [
          positionDetail({
            assetId: 'asset-provider',
            assetType: AssetType.domestic_stock,
            currencyCode: CurrencyCode.KRW,
          }),
        ],
      }),
    );
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-krx',
        assetId: 'asset-provider',
        price: new Prisma.Decimal('100.00000000'),
        currencyCode: CurrencyCode.KRW,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_krx_realtime_trade',
        effectiveAt: new Date('2026-05-20T00:00:00.000Z'),
        capturedAt: new Date('2026-05-20T00:00:00.000Z'),
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      },
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
    });

    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      participants: {
        wouldCreate: 1,
        failed: 0,
      },
      sourceSummary: {
        participantsUsingProviderApi: 1,
        participantsUsingAdminManual: 0,
        participantsUsingFallback: 0,
        providerApiUsed: true,
        adminManualUsed: false,
        fallbackUsed: false,
      },
    });
  });

  it('creates non-dry-run snapshots with provider_api valuation and source summary', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-provider', userId: 'user-provider' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    prisma.tradingAccount.findUnique.mockResolvedValueOnce(
      participantDetail({
        id: 'sp-provider',
        positions: [
          positionDetail({
            assetId: 'asset-provider',
            assetType: AssetType.domestic_stock,
            currencyCode: CurrencyCode.KRW,
          }),
        ],
      }),
    );
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-krx',
        assetId: 'asset-provider',
        price: new Prisma.Decimal('100.00000000'),
        currencyCode: CurrencyCode.KRW,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_krx_realtime_trade',
        effectiveAt: new Date('2026-05-20T00:00:00.000Z'),
        capturedAt: new Date('2026-05-20T00:00:00.000Z'),
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      },
    ]);
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snap-1' });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        seasonParticipantId: 'sp-provider',
        totalAssetKrw: '1000100.00000000',
        assetValueKrw: '100.00000000',
      }),
      select: {
        id: true,
      },
    });
    expect(result).toMatchObject({
      participants: {
        created: 1,
        failed: 0,
      },
      createdSnapshotIds: ['snap-1'],
      sourceSummary: {
        participantsUsingProviderApi: 1,
        providerApiUsed: true,
        fallbackUsed: false,
      },
    });
  });

  it('succeeds with admin_manual fallback when provider_api is stale', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-fallback', userId: 'user-fallback' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    prisma.tradingAccount.findUnique.mockResolvedValueOnce(
      participantDetail({
        id: 'sp-fallback',
        positions: [
          positionDetail({
            assetId: 'asset-provider',
            assetType: AssetType.domestic_stock,
            currencyCode: CurrencyCode.KRW,
          }),
        ],
      }),
    );
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-stale',
        assetId: 'asset-provider',
        price: new Prisma.Decimal('999.00000000'),
        currencyCode: CurrencyCode.KRW,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_krx_realtime_trade',
        effectiveAt: new Date('2026-05-19T23:58:00.000Z'),
        capturedAt: new Date('2026-05-19T23:59:29.000Z'),
        createdAt: new Date('2026-05-19T23:59:29.000Z'),
      },
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'admin-price-krx',
      assetId: 'asset-provider',
      price: new Prisma.Decimal('100.00000000'),
      currencyCode: CurrencyCode.KRW,
      sourceType: AssetPriceSourceType.admin_manual,
      sourceName: 'manual-price',
      effectiveAt: new Date('2026-05-20T00:00:00.000Z'),
      capturedAt: new Date('2026-05-20T00:00:00.000Z'),
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
    });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
    });

    expect(result).toMatchObject({
      participants: {
        wouldCreate: 1,
        failed: 0,
      },
      sourceSummary: {
        participantsUsingProviderApi: 0,
        participantsUsingAdminManual: 1,
        participantsUsingFallback: 1,
        providerApiUsed: false,
        adminManualUsed: true,
        fallbackUsed: true,
        fallbackReasons: ['provider_rejected'],
        rejectedProviderReasons: ['effective_at_outside_current_session'],
      },
    });
  });

  it('does not allow official_batch valuation sources', async () => {
    const { service, prisma } = createServiceWithRealValuation();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-official', userId: 'user-official' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    prisma.tradingAccount.findUnique.mockResolvedValueOnce(
      participantDetail({
        id: 'sp-official',
        positions: [
          positionDetail({
            assetId: 'asset-official',
            assetType: AssetType.domestic_stock,
            currencyCode: CurrencyCode.KRW,
          }),
        ],
      }),
    );
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      assetId: 'asset-official',
      price: new Prisma.Decimal('100.00000000'),
      currencyCode: CurrencyCode.KRW,
      sourceType: AssetPriceSourceType.official_batch,
      effectiveAt: new Date('2026-05-20T00:00:00.000Z'),
      capturedAt: new Date('2026-05-20T00:00:00.000Z'),
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
    });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(result.participants.failed).toBe(1);
    expect(result.errors.map((error) => error.code)).toEqual([
      'ASSET_PRICE_UNAVAILABLE',
    ]);
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
  });

  it('preserves valuation scale strings when creating a snapshot', async () => {
    const { service, prisma, valuationService } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue([]);
    valuationService.calculateTradingAccountValuation.mockResolvedValue(
      valuation('sp-1', {
        totalAssetKrw: '1234567.89000000',
        krwCash: '1000000.00000000',
        usdCashKrw: '234567.89000000',
        assetValueKrw: '0.00000000',
        realizedPnlKrw: '12.34000000',
        unrealizedPnlKrw: '-56.78000000',
        returnRate: '23.45678900',
      }),
    );
    prisma.dailyPortfolioSnapshot.create.mockResolvedValue({ id: 'snap-1' });

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.dailyPortfolioSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        totalAssetKrw: '1234567.89000000',
        krwCash: '1000000.00000000',
        usdCashKrw: '234567.89000000',
        assetValueKrw: '0.00000000',
        realizedPnlKrw: '12.34000000',
        unrealizedPnlKrw: '-56.78000000',
        returnRate: '23.45678900',
      }),
      select: {
        id: true,
      },
    });
  });

  function createService() {
    const prisma = createPrismaMock();
    const batchService = createBatchServiceMock(startedAt);
    const valuationService = {
      calculateTradingAccountValuation: jest.fn(),
    };
    const service = new DailyPortfolioSnapshotJobService(
      batchService as never,
      prisma as never,
      valuationService as never,
    );

    return {
      service,
      prisma,
      batchService,
      valuationService,
    };
  }

  function createServiceWithRealValuation() {
    const prisma = createPrismaMock();
    const batchService = createBatchServiceMock(startedAt);
    const valuationService = new PortfolioValuationService(prisma as never);
    const service = new DailyPortfolioSnapshotJobService(
      batchService as never,
      prisma as never,
      valuationService,
    );

    return {
      service,
      prisma,
      batchService,
      valuationService,
    };
  }
});

function createPrismaMock() {
  return {
    season: {
      findUnique: jest.fn(),
    },
    seasonParticipant: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    tradingAccount: {
      findUnique: jest.fn(),
    },
    dailyPortfolioSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    fxRateSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
  };
}

function createBatchServiceMock(startedAt: Date): BatchServiceMock {
  return {
    runJob: jest.fn(async (params) => {
      const result = await params.handler({
        runId: 'run-1',
        jobName: params.jobName,
        idempotencyKey: params.idempotencyKey,
        dryRun: params.dryRun === true,
        startedAt,
      });

      return {
        success: true,
        data: {
          run: {
            id: 'run-1',
            jobName: params.jobName,
            idempotencyKey: params.idempotencyKey,
            status: 'succeeded',
            dryRun: params.dryRun === true,
            startedAt: startedAt.toISOString(),
            finishedAt: startedAt.toISOString(),
            requestedBy: params.requestedBy ?? null,
            requestPayloadJson: params.requestPayload ?? null,
            resultPayloadJson: result,
            errorCode: null,
            errorMessage: null,
            createdAt: startedAt.toISOString(),
            updatedAt: startedAt.toISOString(),
          },
          deduplicated: false,
          skipped: false,
        },
      };
    }),
  };
}

async function runAndGetResult(
  service: DailyPortfolioSnapshotJobService,
  input: Parameters<DailyPortfolioSnapshotJobService['run']>[0],
): Promise<DailyPortfolioSnapshotJobResult> {
  const response = await service.run(input);

  return response.data.run
    .resultPayloadJson as unknown as DailyPortfolioSnapshotJobResult;
}

function mockSeason(prisma: PrismaMock, status: SeasonStatus) {
  prisma.season.findUnique.mockResolvedValue({
    id: 'season-1',
    status,
  });
}

function mockParticipants(
  prisma: PrismaMock,
  participants: Array<{
    id: string;
    userId: string;
    tradingAccountId?: string | null;
  }>,
) {
  prisma.seasonParticipant.findMany.mockResolvedValue(
    participants.map((participant) => ({
      // 작업 7 dual-write: every snapshot records the account too, so the
      // default fixture has a link. Pass `tradingAccountId: null` explicitly
      // to exercise the fail-closed path.
      tradingAccountId: `account-of-${participant.id}`,
      ...participant,
    })),
  );
}

function valuation(
  seasonParticipantId: string,
  overrides: Partial<ValuationFixture> = {},
) {
  return {
    ...baseValuationFixture(),
    seasonParticipantId,
    ...overrides,
  };
}

type ValuationFixture = ReturnType<typeof baseValuationFixture>;

function baseValuationFixture() {
  return {
    seasonParticipantId: 'sp-1',
    totalAssetKrw: '1200000.00000000',
    returnRate: '20.00000000',
    krwCash: '900000.00000000',
    usdCashKrw: '140000.00000000',
    assetValueKrw: '160000.00000000',
    domesticStockValueKrw: '60000.00000000',
    usStockValueKrw: '70000.00000000',
    cryptoValueKrw: '30000.00000000',
    realizedPnlKrw: '10000.00000000',
    unrealizedPnlKrw: '20000.00000000',
    valuationAt: new Date('2026-05-20T00:00:30.000Z'),
    sourceSummary: {
      providerApiUsed: false,
      adminManualUsed: false,
      fallbackUsed: false,
      fallbackReasons: [],
      rejectedProviderReasons: [],
    },
    assetPriceSourceDecisions: [],
    fxRateSourceDecision: null,
  };
}

function participantDetail(input: {
  id: string;
  krwCash?: string;
  usdCash?: string;
  positions?: ReturnType<typeof positionDetail>[];
}) {
  return {
    id: `account-of-${input.id}`,
    userId: `user-of-${input.id}`,
    mode: 'season',
    initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
    seasonParticipant: {
      id: input.id,
      userId: `user-of-${input.id}`,
      initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
    },
    cashWallets: [
      {
        currencyCode: CurrencyCode.KRW,
        balanceAmount: new Prisma.Decimal(input.krwCash ?? '1000000.00000000'),
      },
      {
        currencyCode: CurrencyCode.USD,
        balanceAmount: new Prisma.Decimal(input.usdCash ?? '0.00000000'),
      },
    ],
    positions: input.positions ?? [],
  };
}

function positionDetail(input: {
  assetId: string;
  assetType: AssetType;
  currencyCode: CurrencyCode;
}) {
  return {
    assetId: input.assetId,
    quantity: new Prisma.Decimal('1.00000000'),
    averageCost: new Prisma.Decimal('100.00000000'),
    currencyCode: input.currencyCode,
    realizedPnl: new Prisma.Decimal('0.00000000'),
    realizedPnlKrw: new Prisma.Decimal('0.00000000'),
    asset: {
      id: input.assetId,
      assetType: input.assetType,
      market:
        input.assetType === AssetType.domestic_stock
          ? 'KRX'
          : input.assetType === AssetType.us_stock
            ? 'NAS'
            : 'BINANCE',
      currencyCode: input.currencyCode,
    },
  };
}
