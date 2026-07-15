jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal, DbNull: Symbol('Prisma.DbNull') },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    MarketCandleSyncMode: {
      initial: 'initial',
      incremental: 'incremental',
      repair: 'repair',
    },
    MarketCandleSyncStatus: {
      pending: 'pending',
      running: 'running',
      completed: 'completed',
      failed: 'failed',
      canceled: 'canceled',
    },
  };
});

import { MarketCandleSyncService } from './market-candle-sync.service';
import { KisPeriodCandleNormalizerService } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { MarketCandleSyncInputError } from './market-candle-sync.types';
import type { MarketCandleSyncConfig } from './market-candle-sync.config';

const DAY = 24 * 60 * 60_000;
const FIVE_MIN = 5 * 60_000;
const NOW = new Date('2026-07-10T12:00:00Z');

const CRYPTO_ASSET = {
  id: 'crypto-1',
  symbol: 'BTC',
  market: 'BINANCE',
  assetType: 'crypto',
  isActive: true,
};
const DOMESTIC_ASSET = {
  id: 'dom-1',
  symbol: '005930',
  market: 'KOSPI',
  assetType: 'domestic_stock',
  isActive: true,
};

type StateRow = {
  id: string;
  assetId: string;
  feed: string;
  sourceProvider: string;
  mode: string;
  status: string;
  targetFrom: Date;
  targetTo: Date;
  cursorJson: Record<string, unknown> | null;
  pagesFetched: number;
  providerRowsReceived: number;
  rowsAccepted: number;
  rowsRejected: number;
  rowsDuplicated: number;
  rowsWritten: number;
  lastSuccessfulPageAt: Date | null;
  completedAt: Date | null;
  coverageComplete: boolean;
  completionReason: string | null;
  coveredFrom: Date | null;
  coveredTo: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
};

class FakeStateRepository {
  rows: StateRow[] = [];
  private sequence = 0;

  async createRunning(input: {
    assetId: string;
    feed: string;
    sourceProvider: string;
    mode: string;
    targetFrom: Date;
    targetTo: Date;
  }): Promise<StateRow> {
    const row: StateRow = {
      id: `sync-${(this.sequence += 1)}`,
      ...input,
      status: 'running',
      cursorJson: null,
      pagesFetched: 0,
      providerRowsReceived: 0,
      rowsAccepted: 0,
      rowsRejected: 0,
      rowsDuplicated: 0,
      rowsWritten: 0,
      lastSuccessfulPageAt: null,
      completedAt: null,
      coverageComplete: false,
      completionReason: null,
      coveredFrom: null,
      coveredTo: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(Date.now() + this.sequence),
    };
    this.rows.push(row);
    return { ...row };
  }

  async findResumable(assetId: string, feed: string): Promise<StateRow | null> {
    const candidates = this.rows
      .filter(
        (row) =>
          row.assetId === assetId &&
          row.feed === feed &&
          ['pending', 'running', 'failed', 'canceled'].includes(row.status) &&
          row.errorCode !== 'SUPERSEDED',
      )
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      );
    return candidates[0] ? { ...candidates[0] } : null;
  }

  async findById(id: string): Promise<StateRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? { ...row } : null;
  }

  async resumeRun(id: string): Promise<StateRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (
      !row ||
      !['pending', 'running', 'failed', 'canceled'].includes(row.status)
    ) {
      return null;
    }
    row.status = 'running';
    row.errorCode = null;
    row.errorMessage = null;
    row.completedAt = null;
    return { ...row };
  }

  async recordPageSuccess(
    id: string,
    progress: {
      cursorJson: Record<string, unknown> | null;
      pagesFetched: number;
      providerRowsReceived: number;
      rowsAccepted: number;
      rowsRejected: number;
      rowsDuplicated: number;
      rowsWritten: number;
      lastSuccessfulPageAt: Date;
      coveredFrom: Date | null;
      coveredTo: Date | null;
    },
  ): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.status !== 'running') return false;
    row.cursorJson = progress.cursorJson;
    row.pagesFetched += progress.pagesFetched;
    row.providerRowsReceived += progress.providerRowsReceived;
    row.rowsAccepted += progress.rowsAccepted;
    row.rowsRejected += progress.rowsRejected;
    row.rowsDuplicated += progress.rowsDuplicated;
    row.rowsWritten += progress.rowsWritten;
    row.lastSuccessfulPageAt = progress.lastSuccessfulPageAt;
    row.coveredFrom = progress.coveredFrom;
    row.coveredTo = progress.coveredTo;
    return true;
  }

  completionInputs: {
    id: string;
    coverageComplete: boolean;
    completionReason: string;
    requiredCoveredTo: Date;
  }[] = [];

  // Mirrors MarketCandleSyncStateRepository.markCompleted's invariant so the
  // service tests fail loudly on any claim the real repository would reject.
  async markCompleted(
    id: string,
    completedAt: Date,
    coverage: {
      coverageComplete: boolean;
      completionReason: string;
      coveredFrom: Date | null;
      coveredTo: Date | null;
      requiredCoveredTo: Date;
    },
  ): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.status !== 'running') return false;
    this.completionInputs.push({
      id,
      coverageComplete: coverage.coverageComplete,
      completionReason: coverage.completionReason,
      requiredCoveredTo: coverage.requiredCoveredTo,
    });
    if (
      !(coverage.requiredCoveredTo instanceof Date) ||
      Number.isNaN(coverage.requiredCoveredTo.getTime())
    ) {
      throw new Error('requiredCoveredTo must be a valid Date.');
    }
    if (coverage.coverageComplete) {
      const requiredToMs = coverage.requiredCoveredTo.getTime();
      if (
        !['target_reached', 'confirmed_empty'].includes(
          coverage.completionReason,
        ) ||
        coverage.coveredFrom === null ||
        coverage.coveredTo === null ||
        requiredToMs < row.targetFrom.getTime() ||
        requiredToMs > row.targetTo.getTime() ||
        coverage.coveredFrom.getTime() >= coverage.coveredTo.getTime() ||
        coverage.coveredFrom.getTime() > row.targetFrom.getTime() ||
        coverage.coveredTo.getTime() < requiredToMs
      ) {
        throw new Error(
          'coverageComplete=true requires a covered range spanning the target range.',
        );
      }
    } else {
      if (
        ['target_reached', 'confirmed_empty'].includes(
          coverage.completionReason,
        ) ||
        (coverage.coveredFrom === null) !== (coverage.coveredTo === null) ||
        (coverage.coveredFrom !== null &&
          coverage.coveredTo !== null &&
          coverage.coveredFrom.getTime() >= coverage.coveredTo.getTime())
      ) {
        throw new Error(
          'coverageComplete=false requires an incomplete reason and a well-formed or absent covered range.',
        );
      }
    }
    row.status = 'completed';
    row.completedAt = completedAt;
    row.coverageComplete = coverage.coverageComplete;
    row.completionReason = coverage.completionReason;
    row.coveredFrom = coverage.coveredFrom;
    row.coveredTo = coverage.coveredTo;
    return true;
  }

  async markFailed(
    id: string,
    failure: { errorCode: string; errorMessage: string | null },
  ): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || !['running', 'pending'].includes(row.status)) return false;
    row.status = 'failed';
    row.errorCode = failure.errorCode;
    row.errorMessage = failure.errorMessage;
    return true;
  }

  async markCanceled(
    id: string,
    reason: { errorCode: string; errorMessage: string | null },
  ): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || !['running', 'pending'].includes(row.status)) return false;
    row.status = 'canceled';
    row.errorCode = reason.errorCode;
    row.errorMessage = reason.errorMessage;
    return true;
  }

  async cancelActiveRuns(
    assetId: string,
    feed: string,
    reason: string,
  ): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (
        row.assetId === assetId &&
        row.feed === feed &&
        ['pending', 'running'].includes(row.status)
      ) {
        row.status = 'canceled';
        row.errorCode = 'SUPERSEDED';
        row.errorMessage = reason;
        count += 1;
      }
    }
    return count;
  }
}

function binancePage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    candles: [],
    providerReturnedRows: 0,
    acceptedRows: 0,
    rejectedRows: 0,
    duplicateRows: 0,
    nextCursor: null,
    stopReason: 'target_reached',
    complete: true,
    ...overrides,
  };
}

function syntheticCandle(openMs: number) {
  return {
    openTime: new Date(openMs),
    closeTime: new Date(openMs + FIVE_MIN),
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volume: '10',
    amount: '1010',
    isClosed: true,
    sourceUpdatedAt: NOW,
  };
}

describe('MarketCandleSyncService', () => {
  const createHarness = (
    input: {
      assets?: unknown[];
      config?: Partial<MarketCandleSyncConfig>;
    } = {},
  ) => {
    const assets = input.assets ?? [CRYPTO_ASSET];
    const prisma = {
      asset: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(
            (assets as { id: string }[]).find(
              (asset) => asset.id === where.id,
            ) ?? null,
          ),
        ),
        findMany: jest.fn().mockResolvedValue(assets),
      },
    };
    const upserted: unknown[][] = [];
    const repository = {
      upsertMany: jest.fn(async (rows: unknown[]) => {
        upserted.push(rows);
        return { writtenCount: rows.length };
      }),
      findLatest: jest.fn().mockResolvedValue(null),
    };
    const stateRepository = new FakeStateRepository();
    const lockEvents: string[] = [];
    const lockService = {
      acquire: jest.fn(async ({ assetId, feed }) => {
        lockEvents.push(`acquire:${assetId}:${feed}`);
        return {
          acquired: true,
          handle: {
            assetId,
            feed,
            lock: { key: 'k', token: 't', ttlMs: 1 },
            ttlMs: 1,
            renewIntervalMs: 1,
            lastRenewedAtMs: 0,
          },
        };
      }),
      renewIfDue: jest.fn().mockResolvedValue(true),
      release: jest.fn(async ({ assetId, feed }) => {
        lockEvents.push(`release:${assetId}:${feed}`);
        return true;
      }),
    };
    const fiveMinuteIngestion = {
      fetchDomesticFiveMinuteCandles: jest.fn(),
      fetchUsFiveMinuteCandles: jest.fn(),
    };
    const domesticPeriodAdapter = { fetchPeriodPage: jest.fn() };
    const overseasPeriodAdapter = { fetchPeriodPage: jest.fn() };
    const binanceCandles = { fetchKlinesPage: jest.fn() };
    const config: MarketCandleSyncConfig = {
      maxPages: 50,
      maxRows: 100_000,
      maxDurationMs: 60_000,
      assetConcurrency: 1,
      incrementalOverlapMinutes: 120,
      lockTtlSeconds: 120,
      lockRenewSeconds: 40,
      ...input.config,
    };
    const cache = {
      invalidateAsset: jest.fn().mockResolvedValue({ status: 'invalidated', generation: 1 }),
    };
    const service = new MarketCandleSyncService(
      prisma as never,
      repository as never,
      stateRepository as never,
      lockService as never,
      fiveMinuteIngestion as never,
      domesticPeriodAdapter as never,
      overseasPeriodAdapter as never,
      new KisPeriodCandleNormalizerService(),
      binanceCandles as never,
      config,
      cache as never,
    );
    return {
      service,
      prisma,
      repository,
      upserted,
      stateRepository,
      lockService,
      lockEvents,
      cache,
      fiveMinuteIngestion,
      domesticPeriodAdapter,
      overseasPeriodAdapter,
      binanceCandles,
    };
  };

  it('advances the checkpoint cursor only after each page is written', async () => {
    const harness = createHarness();
    const start = NOW.getTime() - DAY;
    harness.binanceCandles.fetchKlinesPage
      .mockResolvedValueOnce(
        binancePage({
          candles: [syntheticCandle(start), syntheticCandle(start + FIVE_MIN)],
          providerReturnedRows: 2,
          acceptedRows: 2,
          nextCursor: { startTime: start + 2 * FIVE_MIN },
          stopReason: null,
          complete: false,
        }),
      )
      .mockResolvedValueOnce(
        binancePage({
          candles: [syntheticCandle(start + 2 * FIVE_MIN)],
          providerReturnedRows: 1,
          acceptedRows: 1,
        }),
      );

    const result = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      mode: 'initial' as never,
      from: new Date(start),
      to: NOW,
      now: NOW,
    });

    const feed = result.feeds[0];
    expect(feed.status).toBe('completed');
    expect(feed.complete).toBe(true);
    expect(feed.stopReason).toBe('target_reached');
    expect(feed.pagesFetched).toBe(2);
    expect(feed.acceptedRows).toBe(3);
    expect(feed.writtenRows).toBe(3);
    expect(harness.cache.invalidateAsset).toHaveBeenCalledTimes(1);
    expect(harness.cache.invalidateAsset).toHaveBeenCalledWith(CRYPTO_ASSET.id);
    expect(harness.repository.upsertMany).toHaveBeenCalledTimes(2);
    // The second provider call received the cursor persisted after page one.
    expect(
      harness.binanceCandles.fetchKlinesPage.mock.calls[1][0].cursor,
    ).toEqual({ startTime: start + 2 * FIVE_MIN });
    const row = harness.stateRepository.rows[0];
    expect(row.status).toBe('completed');
    expect(row.rowsWritten).toBe(3);
    // Rows carry the feed interval and provider source.
    const firstBatch = harness.upserted[0] as {
      interval: string;
      sourceProvider: string;
    }[];
    expect(firstBatch[0]).toMatchObject({
      interval: '5m',
      sourceProvider: 'binance_klines',
    });
  });

  it('keeps the cursor when the candle write fails, then resumes safely', async () => {
    const harness = createHarness();
    const start = NOW.getTime() - DAY;
    const page = binancePage({
      candles: [syntheticCandle(start)],
      providerReturnedRows: 1,
      acceptedRows: 1,
    });
    harness.binanceCandles.fetchKlinesPage.mockResolvedValue(page);
    harness.repository.upsertMany.mockRejectedValueOnce(
      new Error('db write failed'),
    );

    const failed = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      mode: 'initial' as never,
      from: new Date(start),
      to: NOW,
      now: NOW,
    });
    expect(failed.feeds[0].status).toBe('failed');
    expect(failed.feeds[0].stopReason).toBe('write_failed');
    expect(failed.feeds[0].errorCode).toBe('CANDLE_WRITE_FAILED');
    const row = harness.stateRepository.rows[0];
    expect(row.status).toBe('failed');
    // Cursor was NOT advanced past the unwritten page.
    expect(row.cursorJson).toBeNull();
    expect(row.rowsWritten).toBe(0);

    // Resume re-fetches the same page; the idempotent upsert now succeeds.
    const resumed = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      now: NOW,
    });
    expect(resumed.feeds[0].resumed).toBe(true);
    expect(resumed.feeds[0].syncStateId).toBe(row.id);
    expect(resumed.feeds[0].status).toBe('completed');
    expect(harness.stateRepository.rows).toHaveLength(1);
    expect(harness.stateRepository.rows[0].rowsWritten).toBe(1);
  });

  it('resumes a provider-failed run from its stored cursor and target range', async () => {
    const harness = createHarness();
    const start = NOW.getTime() - DAY;
    harness.binanceCandles.fetchKlinesPage
      .mockResolvedValueOnce(
        binancePage({
          candles: [syntheticCandle(start)],
          providerReturnedRows: 1,
          acceptedRows: 1,
          nextCursor: { startTime: start + FIVE_MIN },
          stopReason: null,
          complete: false,
        }),
      )
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        binancePage({
          candles: [syntheticCandle(start + FIVE_MIN)],
          providerReturnedRows: 1,
          acceptedRows: 1,
        }),
      );

    const failed = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      mode: 'initial' as never,
      from: new Date(start),
      to: NOW,
      now: NOW,
    });
    expect(failed.feeds[0].status).toBe('failed');
    expect(failed.feeds[0].stopReason).toBe('provider_error');
    expect(harness.stateRepository.rows[0].cursorJson).toEqual({
      startTime: start + FIVE_MIN,
    });

    const laterNow = new Date(NOW.getTime() + 60 * 60_000);
    const resumed = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      now: laterNow,
    });
    expect(resumed.feeds[0].resumed).toBe(true);
    expect(resumed.feeds[0].status).toBe('completed');
    const resumeCall = harness.binanceCandles.fetchKlinesPage.mock.calls[2][0];
    expect(resumeCall.cursor).toEqual({ startTime: start + FIVE_MIN });
    // The resumed run keeps ITS stored target range, not a recomputed one.
    expect(resumeCall.from.getTime()).toBe(start);
    expect(resumeCall.to.getTime()).toBe(NOW.getTime());
  });

  it('never resumes a completed run; a new run is created instead', async () => {
    const harness = createHarness();
    harness.binanceCandles.fetchKlinesPage.mockResolvedValue(
      binancePage({
        candles: [syntheticCandle(NOW.getTime() - DAY)],
        providerReturnedRows: 1,
        acceptedRows: 1,
      }),
    );
    await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      mode: 'initial' as never,
      now: NOW,
    });
    const second = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      mode: 'initial' as never,
      now: NOW,
    });
    expect(second.feeds[0].resumed).toBe(false);
    expect(harness.stateRepository.rows).toHaveLength(2);
    expect(harness.stateRepository.rows[0].status).toBe('completed');
    expect(harness.stateRepository.rows[1].status).toBe('completed');
  });

  it('fails fast with LOCK_BUSY when another owner holds the asset/feed lock', async () => {
    const harness = createHarness();
    harness.lockService.acquire.mockResolvedValue({
      acquired: false,
      reason: 'busy',
    });
    const result = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      now: NOW,
    });
    expect(result.feeds[0].status).toBe('failed');
    expect(result.feeds[0].errorCode).toBe('LOCK_BUSY');
    expect(harness.binanceCandles.fetchKlinesPage).not.toHaveBeenCalled();
    expect(harness.stateRepository.rows).toHaveLength(0);
  });

  it('stops before the next provider page when lock ownership is lost', async () => {
    const harness = createHarness();
    const start = NOW.getTime() - DAY;
    harness.binanceCandles.fetchKlinesPage.mockResolvedValue(
      binancePage({
        candles: [syntheticCandle(start)],
        providerReturnedRows: 1,
        acceptedRows: 1,
        nextCursor: { startTime: start + FIVE_MIN },
        stopReason: null,
        complete: false,
      }),
    );
    harness.lockService.renewIfDue
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const result = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      mode: 'initial' as never,
      now: NOW,
    });
    expect(result.feeds[0].status).toBe('failed');
    expect(result.feeds[0].errorCode).toBe('LOCK_OWNERSHIP_LOST');
    expect(harness.binanceCandles.fetchKlinesPage).toHaveBeenCalledTimes(1);
    // The written page's checkpoint survives for a later resume.
    expect(harness.stateRepository.rows[0].cursorJson).toEqual({
      startTime: start + FIVE_MIN,
    });
  });

  it('dryRun plans ranges without locks, provider calls, or writes', async () => {
    const harness = createHarness();
    const summary = await harness.service.syncAssets({
      dryRun: true,
      mode: 'initial' as never,
      now: NOW,
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.assets[0].feeds).toHaveLength(3);
    const fiveMinute = summary.assets[0].feeds.find(
      (feed) => feed.interval === '5m',
    );
    expect(fiveMinute?.stopReason).toBe('dry_run');
    expect(fiveMinute?.rangeFrom.getTime()).toBe(NOW.getTime() - 35 * DAY);
    const daily = summary.assets[0].feeds.find(
      (feed) => feed.interval === '1d',
    );
    expect(daily?.rangeFrom.getTime()).toBe(NOW.getTime() - 365 * DAY);
    expect(harness.lockService.acquire).not.toHaveBeenCalled();
    expect(harness.binanceCandles.fetchKlinesPage).not.toHaveBeenCalled();
    expect(harness.repository.upsertMany).not.toHaveBeenCalled();
    expect(harness.stateRepository.rows).toHaveLength(0);
  });

  it('incremental mode restarts from the latest stored row minus the overlap', async () => {
    const harness = createHarness();
    const latestOpen = new Date(NOW.getTime() - 6 * 60 * 60_000);
    harness.repository.findLatest.mockResolvedValue({
      openTime: latestOpen,
    });
    harness.binanceCandles.fetchKlinesPage.mockResolvedValue(binancePage());
    await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      now: NOW,
    });
    const call = harness.binanceCandles.fetchKlinesPage.mock.calls[0][0];
    // overlap = max(120min, 2*5m) = 120 minutes.
    expect(call.from.getTime()).toBe(latestOpen.getTime() - 120 * 60_000);
    expect(call.to.getTime()).toBe(NOW.getTime());
  });

  it('repair mode requires an explicit from/to range', async () => {
    const harness = createHarness();
    await expect(
      harness.service.syncAssets({ mode: 'repair' as never, now: NOW }),
    ).rejects.toBeInstanceOf(MarketCandleSyncInputError);
  });

  it('stops budgeted runs as failed-but-resumable (max_pages)', async () => {
    const harness = createHarness({ config: { maxPages: 1 } });
    const start = NOW.getTime() - DAY;
    harness.binanceCandles.fetchKlinesPage.mockResolvedValue(
      binancePage({
        candles: [syntheticCandle(start)],
        providerReturnedRows: 1,
        acceptedRows: 1,
        nextCursor: { startTime: start + FIVE_MIN },
        stopReason: null,
        complete: false,
      }),
    );
    const result = await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      mode: 'initial' as never,
      now: NOW,
    });
    expect(result.feeds[0].status).toBe('failed');
    expect(result.feeds[0].stopReason).toBe('max_pages');
    expect(result.feeds[0].complete).toBe(false);
    expect(harness.stateRepository.rows[0].cursorJson).toEqual({
      startTime: start + FIVE_MIN,
    });
  });

  it('syncs domestic 1d through the period adapter with backward date paging', async () => {
    const harness = createHarness({ assets: [DOMESTIC_ASSET] });
    const receivedAt = new Date('2026-07-10T07:00:00Z');
    const domesticRow = (date: string) => ({
      value: {
        stck_bsop_date: date,
        stck_clpr: '101',
        stck_oprc: '100',
        stck_hgpr: '102',
        stck_lwpr: '99',
        acml_vol: '1000',
        acml_tr_pbmn: '101000',
      },
      receivedAt,
      sequence: 0,
    });
    harness.domesticPeriodAdapter.fetchPeriodPage
      .mockResolvedValueOnce({
        state: 'ok',
        rows: [domesticRow('20260710'), domesticRow('20260709')],
        providerReturnedRows: 2,
        blankRows: 0,
        oldestDate: '20260709',
        latestDate: '20260710',
        trCont: 'D',
      })
      .mockResolvedValueOnce({
        state: 'ok',
        rows: [domesticRow('20260708')],
        providerReturnedRows: 1,
        blankRows: 0,
        oldestDate: '20260708',
        latestDate: '20260708',
        trCont: 'D',
      });

    const result = await harness.service.syncAsset({
      assetId: DOMESTIC_ASSET.id,
      targets: ['1d'],
      mode: 'repair' as never,
      from: new Date('2026-07-07T15:00:00Z'), // 2026-07-08 00:00 KST
      to: new Date('2026-07-10T15:00:00Z'),
      now: NOW,
    });

    const feed = result.feeds[0];
    expect(feed.status).toBe('completed');
    expect(feed.complete).toBe(true);
    expect(feed.provider).toBe('kis_domestic_period');
    expect(feed.acceptedRows).toBe(3);
    // Page 2 was requested with the cursor one day before page 1's oldest.
    const secondCall =
      harness.domesticPeriodAdapter.fetchPeriodPage.mock.calls[1][0];
    expect(secondCall.endDate).toBe('20260708');
    expect(secondCall.fromDate).toBe('20260708');
    const writtenRows = harness.upserted.flat() as {
      interval: string;
      sourceProvider: string;
      openTime: Date;
    }[];
    expect(writtenRows).toHaveLength(3);
    expect(writtenRows[0]).toMatchObject({
      interval: '1d',
      sourceProvider: 'kis_domestic_period',
    });
  });

  it('detects a non-advancing domestic date cursor and fails the run', async () => {
    const harness = createHarness({ assets: [DOMESTIC_ASSET] });
    harness.domesticPeriodAdapter.fetchPeriodPage.mockResolvedValue({
      state: 'ok',
      rows: [
        {
          value: {
            stck_bsop_date: '20270101', // beyond the cursor: cursor cannot move back
            stck_clpr: '101',
            stck_oprc: '100',
            stck_hgpr: '102',
            stck_lwpr: '99',
            acml_vol: '1000',
          },
          receivedAt: NOW,
          sequence: 0,
        },
      ],
      providerReturnedRows: 1,
      blankRows: 0,
      oldestDate: '20270101',
      latestDate: '20270101',
      trCont: null,
    });
    const result = await harness.service.syncAsset({
      assetId: DOMESTIC_ASSET.id,
      targets: ['1d'],
      mode: 'repair' as never,
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-07-01T00:00:00Z'),
      now: NOW,
    });
    expect(result.feeds[0].status).toBe('failed');
    expect(result.feeds[0].stopReason).toBe('cursor_not_advanced');
    expect(result.feeds[0].complete).toBe(false);
  });

  it('sweeps KIS 5m feeds in bounded segments, checkpointing between segments', async () => {
    const harness = createHarness({ assets: [DOMESTIC_ASSET] });
    harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles.mockImplementation(
      ({ from }: { from: Date }) =>
        Promise.resolve({
          provider: 'kis_domestic_minute',
          assetId: DOMESTIC_ASSET.id,
          rangeFrom: from,
          rangeTo: from,
          pagesFetched: 2,
          providerReturnedRows: 10,
          acceptedRows: 5,
          rejectedRows: 0,
          duplicateRows: 0,
          candles: [syntheticCandle(from.getTime())],
          complete: true,
          stopReason: 'target_reached',
          oldestOpenTime: from,
          latestOpenTime: from,
        }),
    );
    const to = new Date('2026-07-10T00:00:00Z');
    const from = new Date(to.getTime() - 5 * DAY);
    const result = await harness.service.syncAsset({
      assetId: DOMESTIC_ASSET.id,
      targets: ['5m'],
      mode: 'repair' as never,
      from,
      to,
      now: NOW,
    });
    expect(result.feeds[0].status).toBe('completed');
    expect(result.feeds[0].complete).toBe(true);
    // Every segment reported complete=true, so the whole target range is
    // provider-confirmed AND data-complete: only then is coverage complete.
    expect(result.feeds[0].coverageComplete).toBe(true);
    expect(result.feeds[0].completionReason).toBe('target_reached');
    expect(harness.stateRepository.rows[0].coveredFrom?.getTime()).toBe(
      from.getTime(),
    );
    expect(harness.stateRepository.rows[0].coveredTo?.getTime()).toBe(
      to.getTime(),
    );
    // 5 days at 2-day segments: [d3,d5), [d1,d3), [d0,d1) — newest first.
    const calls =
      harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles.mock.calls.map(
        (call) => [call[0].from.toISOString(), call[0].to.toISOString()],
      );
    expect(calls).toEqual([
      ['2026-07-08T00:00:00.000Z', '2026-07-10T00:00:00.000Z'],
      ['2026-07-06T00:00:00.000Z', '2026-07-08T00:00:00.000Z'],
      ['2026-07-05T00:00:00.000Z', '2026-07-06T00:00:00.000Z'],
    ]);
    expect(harness.repository.upsertMany).toHaveBeenCalledTimes(3);
    expect(harness.stateRepository.rows[0].pagesFetched).toBe(6);
  });

  it('honors continueOnError=false by skipping later assets after a failure', async () => {
    const secondAsset = { ...CRYPTO_ASSET, id: 'crypto-2', symbol: 'ETH' };
    const harness = createHarness({ assets: [CRYPTO_ASSET, secondAsset] });
    harness.binanceCandles.fetchKlinesPage.mockRejectedValue(
      new Error('provider down'),
    );
    const summary = await harness.service.syncAssets({
      targets: ['5m'],
      continueOnError: false,
      now: NOW,
    });
    expect(summary.processedAssets).toBe(1);
    expect(summary.failedFeeds).toBe(1);
    expect(summary.skippedAssets).toEqual([
      expect.objectContaining({
        assetId: 'crypto-2',
        reason: 'ABORTED_AFTER_FAILURE',
      }),
    ]);
  });

  it('caps the run with maxAssets and reports skipped assets', async () => {
    const secondAsset = { ...CRYPTO_ASSET, id: 'crypto-2', symbol: 'ETH' };
    const harness = createHarness({ assets: [CRYPTO_ASSET, secondAsset] });
    harness.binanceCandles.fetchKlinesPage.mockResolvedValue(binancePage());
    const summary = await harness.service.syncAssets({
      targets: ['5m'],
      maxAssets: 1,
      now: NOW,
    });
    expect(summary.processedAssets).toBe(1);
    expect(summary.skippedAssets).toEqual([
      expect.objectContaining({
        assetId: 'crypto-2',
        reason: 'MAX_ASSETS_EXCEEDED',
      }),
    ]);
  });

  it('reports unsupported assets instead of silently dropping them', async () => {
    const unsupported = {
      id: 'weird-1',
      symbol: 'ABC',
      market: 'LSE',
      assetType: 'us_stock',
      isActive: true,
    };
    const harness = createHarness({ assets: [unsupported] });
    const summary = await harness.service.syncAssets({
      targets: ['5m'],
      now: NOW,
    });
    expect(summary.processedAssets).toBe(0);
    expect(summary.skippedAssets).toEqual([
      expect.objectContaining({
        assetId: 'weird-1',
        reason: 'UNSUPPORTED_US_MARKET',
      }),
    ]);
  });

  it('validates targets and unknown assets', async () => {
    const harness = createHarness();
    await expect(
      harness.service.syncAsset({
        assetId: CRYPTO_ASSET.id,
        targets: ['1m'] as never,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MarketCandleSyncInputError);
    await expect(
      harness.service.syncAsset({ assetId: 'missing', now: NOW }),
    ).rejects.toBeInstanceOf(MarketCandleSyncInputError);
  });

  it('releases the lock even when the run fails', async () => {
    const harness = createHarness();
    harness.binanceCandles.fetchKlinesPage.mockRejectedValue(new Error('boom'));
    await harness.service.syncAsset({
      assetId: CRYPTO_ASSET.id,
      targets: ['5m'],
      now: NOW,
    });
    expect(harness.lockEvents).toEqual([
      `acquire:${CRYPTO_ASSET.id}:5m`,
      `release:${CRYPTO_ASSET.id}:5m`,
    ]);
  });

  describe('coverage completeness', () => {
    it('records a fully swept Binance run as coverage-complete (target_reached)', async () => {
      const harness = createHarness();
      const start = NOW.getTime() - DAY;
      harness.binanceCandles.fetchKlinesPage.mockResolvedValue(
        binancePage({
          candles: [syntheticCandle(start)],
          providerReturnedRows: 1,
          acceptedRows: 1,
        }),
      );
      const result = await harness.service.syncAsset({
        assetId: CRYPTO_ASSET.id,
        targets: ['5m'],
        mode: 'initial' as never,
        from: new Date(start),
        to: NOW,
        now: NOW,
      });
      expect(result.feeds[0].coverageComplete).toBe(true);
      expect(result.feeds[0].completionReason).toBe('target_reached');
      const row = harness.stateRepository.rows[0];
      expect(row.coverageComplete).toBe(true);
      expect(row.completionReason).toBe('target_reached');
      expect(row.coveredFrom?.getTime()).toBe(start);
      expect(row.coveredTo?.getTime()).toBe(NOW.getTime());
    });

    it('records a confirmed-empty Binance range as coverage-complete', async () => {
      const harness = createHarness();
      const start = NOW.getTime() - DAY;
      // Binance klines requests are endTime-bounded, so an empty page
      // positively confirms the absence of candles in the whole window.
      harness.binanceCandles.fetchKlinesPage.mockResolvedValue(
        binancePage({
          stopReason: 'empty_page',
          complete: false,
        }),
      );
      const result = await harness.service.syncAsset({
        assetId: CRYPTO_ASSET.id,
        targets: ['5m'],
        mode: 'initial' as never,
        from: new Date(start),
        to: NOW,
        now: NOW,
      });
      expect(result.feeds[0].status).toBe('completed');
      expect(result.feeds[0].coverageComplete).toBe(true);
      expect(result.feeds[0].completionReason).toBe('confirmed_empty');
    });

    it('keeps a US 5m run that exhausted provider retention as incomplete coverage', async () => {
      const usAsset = {
        id: 'us-1',
        symbol: 'AAPL',
        market: 'NASDAQ',
        assetType: 'us_stock',
        isActive: true,
      };
      const harness = createHarness({ assets: [usAsset] });
      const from = new Date(NOW.getTime() - 35 * DAY);
      const oldestAvailable = new Date(NOW.getTime() - 20 * DAY);
      harness.fiveMinuteIngestion.fetchUsFiveMinuteCandles.mockResolvedValue({
        provider: 'kis_us_minute',
        assetId: usAsset.id,
        rangeFrom: from,
        rangeTo: NOW,
        pagesFetched: 5,
        providerReturnedRows: 100,
        acceptedRows: 80,
        rejectedRows: 0,
        duplicateRows: 0,
        candles: [syntheticCandle(oldestAvailable.getTime())],
        complete: false,
        stopReason: 'provider_exhausted',
        oldestOpenTime: oldestAvailable,
        latestOpenTime: new Date(NOW.getTime() - FIVE_MIN),
      });
      const result = await harness.service.syncAsset({
        assetId: usAsset.id,
        targets: ['5m'],
        mode: 'initial' as never,
        from,
        to: NOW,
        now: NOW,
      });
      const feed = result.feeds[0];
      // The run terminates normally but its coverage never reaches targetFrom,
      // so it must not become serving-coverage evidence.
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      expect(feed.complete).toBe(false);
      expect(feed.completionReason).toBe('provider_exhausted_before_target');
      const row = harness.stateRepository.rows[0];
      expect(row.coverageComplete).toBe(false);
      expect(row.coveredFrom!.getTime()).toBeGreaterThanOrEqual(
        oldestAvailable.getTime(),
      );
      expect(row.coveredTo?.getTime()).toBe(NOW.getTime());
    });

    it('keeps an empty US 5m page before targetFrom as incomplete, never confirmed empty', async () => {
      const usAsset = {
        id: 'us-1',
        symbol: 'AAPL',
        market: 'NASDAQ',
        assetType: 'us_stock',
        isActive: true,
      };
      const harness = createHarness({ assets: [usAsset] });
      harness.fiveMinuteIngestion.fetchUsFiveMinuteCandles.mockResolvedValue({
        provider: 'kis_us_minute',
        assetId: usAsset.id,
        rangeFrom: new Date(NOW.getTime() - 35 * DAY),
        rangeTo: NOW,
        pagesFetched: 1,
        providerReturnedRows: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        duplicateRows: 0,
        candles: [],
        complete: false,
        stopReason: 'empty_page',
        oldestOpenTime: null,
        latestOpenTime: null,
      });
      const result = await harness.service.syncAsset({
        assetId: usAsset.id,
        targets: ['5m'],
        mode: 'initial' as never,
        now: NOW,
      });
      const feed = result.feeds[0];
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      expect(feed.completionReason).toBe('empty_page_before_target');
      expect(harness.stateRepository.rows[0].coveredFrom).toBeNull();
      expect(harness.stateRepository.rows[0].coveredTo).toBeNull();
    });

    it('terminates a domestic 5m sweep at the provider history boundary with partial coverage', async () => {
      const harness = createHarness({ assets: [DOMESTIC_ASSET] });
      harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles
        .mockImplementationOnce(({ from }: { from: Date }) =>
          Promise.resolve({
            provider: 'kis_domestic_minute',
            assetId: DOMESTIC_ASSET.id,
            rangeFrom: from,
            rangeTo: from,
            pagesFetched: 2,
            providerReturnedRows: 10,
            acceptedRows: 5,
            rejectedRows: 0,
            duplicateRows: 0,
            candles: [syntheticCandle(from.getTime())],
            complete: true,
            stopReason: 'target_reached',
            oldestOpenTime: from,
            latestOpenTime: from,
          }),
        )
        .mockImplementationOnce(() =>
          Promise.resolve({
            provider: 'kis_domestic_minute',
            assetId: DOMESTIC_ASSET.id,
            rangeFrom: NOW,
            rangeTo: NOW,
            pagesFetched: 1,
            providerReturnedRows: 0,
            acceptedRows: 0,
            rejectedRows: 0,
            duplicateRows: 0,
            candles: [],
            complete: false,
            stopReason: 'empty_page',
            oldestOpenTime: null,
            latestOpenTime: null,
          }),
        );
      const to = new Date('2026-07-10T00:00:00Z');
      const from = new Date(to.getTime() - 6 * DAY);
      const result = await harness.service.syncAsset({
        assetId: DOMESTIC_ASSET.id,
        targets: ['5m'],
        mode: 'repair' as never,
        from,
        to,
        now: NOW,
      });
      const feed = result.feeds[0];
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      expect(feed.completionReason).toBe('empty_page_before_target');
      // The empty segment proves the provider has nothing older: the run must
      // stop instead of sweeping even older segments.
      expect(
        harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles,
      ).toHaveBeenCalledTimes(2);
      const row = harness.stateRepository.rows[0];
      // Only the first (fully swept) segment is covered: [to-2d, to).
      expect(row.coveredFrom?.getTime()).toBe(to.getTime() - 2 * DAY);
      expect(row.coveredTo?.getTime()).toBe(to.getTime());
    });

    it('keeps a KIS period run that hit an empty page before targetFrom as incomplete', async () => {
      const harness = createHarness({ assets: [DOMESTIC_ASSET] });
      const receivedAt = new Date('2026-07-10T07:00:00Z');
      harness.domesticPeriodAdapter.fetchPeriodPage
        .mockResolvedValueOnce({
          state: 'ok',
          rows: [
            {
              value: {
                stck_bsop_date: '20260710',
                stck_clpr: '101',
                stck_oprc: '100',
                stck_hgpr: '102',
                stck_lwpr: '99',
                acml_vol: '1000',
                acml_tr_pbmn: '101000',
              },
              receivedAt,
              sequence: 0,
            },
          ],
          providerReturnedRows: 1,
          blankRows: 0,
          oldestDate: '20260710',
          latestDate: '20260710',
          trCont: 'D',
        })
        .mockResolvedValueOnce({
          state: 'ok',
          rows: [],
          providerReturnedRows: 0,
          blankRows: 0,
          oldestDate: null,
          latestDate: null,
          trCont: null,
        });
      const result = await harness.service.syncAsset({
        assetId: DOMESTIC_ASSET.id,
        targets: ['1d'],
        mode: 'repair' as never,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-07-10T15:00:00Z'),
        now: NOW,
      });
      const feed = result.feeds[0];
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      expect(feed.completionReason).toBe('empty_page_before_target');
    });

    it('accumulates coverage across a resumed run before declaring completeness', async () => {
      const harness = createHarness();
      const start = NOW.getTime() - DAY;
      harness.binanceCandles.fetchKlinesPage
        .mockResolvedValueOnce(
          binancePage({
            candles: [syntheticCandle(start)],
            providerReturnedRows: 1,
            acceptedRows: 1,
            nextCursor: { startTime: start + FIVE_MIN },
            stopReason: null,
            complete: false,
          }),
        )
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(
          binancePage({
            candles: [syntheticCandle(start + FIVE_MIN)],
            providerReturnedRows: 1,
            acceptedRows: 1,
          }),
        );
      const failed = await harness.service.syncAsset({
        assetId: CRYPTO_ASSET.id,
        targets: ['5m'],
        mode: 'initial' as never,
        from: new Date(start),
        to: NOW,
        now: NOW,
      });
      expect(failed.feeds[0].status).toBe('failed');
      const afterFailure = harness.stateRepository.rows[0];
      expect(afterFailure.coveredFrom?.getTime()).toBe(start);
      expect(afterFailure.coveredTo?.getTime()).toBe(start + FIVE_MIN);

      const resumed = await harness.service.syncAsset({
        assetId: CRYPTO_ASSET.id,
        targets: ['5m'],
        now: NOW,
      });
      expect(resumed.feeds[0].coverageComplete).toBe(true);
      const row = harness.stateRepository.rows[0];
      expect(row.coverageComplete).toBe(true);
      expect(row.coveredFrom?.getTime()).toBe(start);
      expect(row.coveredTo?.getTime()).toBe(NOW.getTime());
    });

    it('never promotes a domestic target_reached sweep with incomplete data to coverage-complete', async () => {
      // Regression: fetchDomesticFiveMinuteCandles reports complete=false
      // (incomplete 5m buckets survived strict validation) even though the
      // provider sweep itself reached the segment target. The stored data
      // has holes, so the checkpoint must NOT become serving coverage.
      const harness = createHarness({ assets: [DOMESTIC_ASSET] });
      const to = new Date('2026-07-10T00:00:00Z');
      const from = new Date(to.getTime() - DAY); // single 2-day segment
      harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles.mockResolvedValue(
        {
          provider: 'kis_domestic_minute',
          assetId: DOMESTIC_ASSET.id,
          rangeFrom: from,
          rangeTo: to,
          pagesFetched: 2,
          providerReturnedRows: 40,
          acceptedRows: 35,
          rejectedRows: 5,
          duplicateRows: 0,
          candles: [
            syntheticCandle(from.getTime()),
            syntheticCandle(from.getTime() + FIVE_MIN),
          ],
          complete: false,
          stopReason: 'target_reached',
          oldestOpenTime: from,
          latestOpenTime: new Date(from.getTime() + FIVE_MIN),
          completeBuckets: 2,
          incompleteBuckets: 1,
          rejectedBuckets: 0,
        },
      );
      const result = await harness.service.syncAsset({
        assetId: DOMESTIC_ASSET.id,
        targets: ['5m'],
        mode: 'repair' as never,
        from,
        to,
        now: NOW,
      });
      const feed = result.feeds[0];
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      expect(feed.complete).toBe(false);
      expect(feed.completionReason).not.toBe('target_reached');
      expect(feed.completionReason).not.toBe('confirmed_empty');
      // Partial candles are still written...
      expect(harness.repository.upsertMany).toHaveBeenCalledTimes(1);
      // ...but the checkpoint claims no covered range and cannot satisfy a
      // findCompletedCovering-style serving query.
      const row = harness.stateRepository.rows[0];
      expect(row.coverageComplete).toBe(false);
      expect(row.coveredFrom).toBeNull();
      expect(row.coveredTo).toBeNull();
      expect(row.completionReason).not.toBe('target_reached');
    });

    it('never promotes a US target_reached sweep with incomplete data to coverage-complete', async () => {
      const usAsset = {
        id: 'us-1',
        symbol: 'AAPL',
        market: 'NASDAQ',
        assetType: 'us_stock',
        isActive: true,
      };
      const harness = createHarness({ assets: [usAsset] });
      const to = new Date('2026-07-10T00:00:00Z');
      const from = new Date(to.getTime() - 30 * DAY); // single 40-day segment
      harness.fiveMinuteIngestion.fetchUsFiveMinuteCandles.mockResolvedValue({
        provider: 'kis_us_minute',
        assetId: usAsset.id,
        rangeFrom: from,
        rangeTo: to,
        pagesFetched: 3,
        providerReturnedRows: 50,
        acceptedRows: 20,
        rejectedRows: 30,
        duplicateRows: 0,
        candles: [syntheticCandle(from.getTime())],
        complete: false,
        stopReason: 'target_reached',
        oldestOpenTime: from,
        latestOpenTime: from,
      });
      const result = await harness.service.syncAsset({
        assetId: usAsset.id,
        targets: ['5m'],
        mode: 'repair' as never,
        from,
        to,
        now: NOW,
      });
      const feed = result.feeds[0];
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      expect(feed.complete).toBe(false);
      expect(feed.completionReason).not.toBe('target_reached');
      const row = harness.stateRepository.rows[0];
      expect(row.coverageComplete).toBe(false);
      expect(row.coveredFrom).toBeNull();
      expect(row.coveredTo).toBeNull();
    });

    it('terminates on an incomplete middle segment without bridging the hole via min/max merge', async () => {
      // Segments sweep newest-first. If the run continued past an
      // incomplete segment, the next (older) segment's coverage would merge
      // with the newer coverage by min/max and silently bridge the hole.
      const harness = createHarness({ assets: [DOMESTIC_ASSET] });
      const to = new Date('2026-07-10T00:00:00Z');
      const from = new Date(to.getTime() - 6 * DAY); // 3 x 2-day segments
      const segment = (input: { from: Date; to: Date }, complete: boolean) => ({
        provider: 'kis_domestic_minute',
        assetId: DOMESTIC_ASSET.id,
        rangeFrom: input.from,
        rangeTo: input.to,
        pagesFetched: 2,
        providerReturnedRows: 20,
        acceptedRows: 20,
        rejectedRows: 0,
        duplicateRows: 0,
        candles: [syntheticCandle(input.from.getTime())],
        complete,
        stopReason: 'target_reached',
        oldestOpenTime: input.from,
        latestOpenTime: input.from,
        completeBuckets: complete ? 4 : 2,
        incompleteBuckets: complete ? 0 : 2,
        rejectedBuckets: 0,
      });
      harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles
        .mockImplementationOnce((input: { from: Date; to: Date }) =>
          Promise.resolve(segment(input, true)),
        )
        .mockImplementationOnce((input: { from: Date; to: Date }) =>
          Promise.resolve(segment(input, false)),
        );
      const result = await harness.service.syncAsset({
        assetId: DOMESTIC_ASSET.id,
        targets: ['5m'],
        mode: 'repair' as never,
        from,
        to,
        now: NOW,
      });
      const feed = result.feeds[0];
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      expect(feed.completionReason).not.toBe('target_reached');
      // The run stopped at the incomplete segment; no older segment was
      // fetched past the hole.
      expect(
        harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles,
      ).toHaveBeenCalledTimes(2);
      // Coverage retains only the fully complete newest segment [to-2d, to);
      // the incomplete segment [to-4d, to-2d) is NOT inside the covered
      // range.
      const row = harness.stateRepository.rows[0];
      expect(row.coveredFrom?.getTime()).toBe(to.getTime() - 2 * DAY);
      expect(row.coveredTo?.getTime()).toBe(to.getTime());
    });

    it('claims no row-derived partial coverage at a retention edge when buckets are incomplete', async () => {
      // provider_exhausted normally claims [oldest received bucket, segTo)
      // as covered. When strict validation dropped incomplete buckets inside
      // that window, the claim would overstate coverage — it must be
      // withheld.
      const harness = createHarness({ assets: [DOMESTIC_ASSET] });
      const to = new Date('2026-07-10T00:00:00Z');
      const from = new Date(to.getTime() - DAY);
      const oldest = new Date(from.getTime() + 2 * FIVE_MIN);
      harness.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles.mockResolvedValue(
        {
          provider: 'kis_domestic_minute',
          assetId: DOMESTIC_ASSET.id,
          rangeFrom: from,
          rangeTo: to,
          pagesFetched: 1,
          providerReturnedRows: 10,
          acceptedRows: 10,
          rejectedRows: 0,
          duplicateRows: 0,
          candles: [syntheticCandle(oldest.getTime())],
          complete: false,
          stopReason: 'provider_exhausted',
          oldestOpenTime: oldest,
          latestOpenTime: oldest,
          completeBuckets: 1,
          incompleteBuckets: 1,
          rejectedBuckets: 0,
        },
      );
      const result = await harness.service.syncAsset({
        assetId: DOMESTIC_ASSET.id,
        targets: ['5m'],
        mode: 'repair' as never,
        from,
        to,
        now: NOW,
      });
      const feed = result.feeds[0];
      expect(feed.status).toBe('completed');
      expect(feed.coverageComplete).toBe(false);
      const row = harness.stateRepository.rows[0];
      expect(row.coveredFrom).toBeNull();
      expect(row.coveredTo).toBeNull();
    });

    it('passes requiredCoveredTo = min(targetTo, now) to the checkpoint completion', async () => {
      const harness = createHarness();
      const start = NOW.getTime() - DAY;
      const futureTo = new Date(NOW.getTime() + DAY);
      harness.binanceCandles.fetchKlinesPage.mockResolvedValue(
        binancePage({
          candles: [syntheticCandle(start)],
          providerReturnedRows: 1,
          acceptedRows: 1,
        }),
      );
      const result = await harness.service.syncAsset({
        assetId: CRYPTO_ASSET.id,
        targets: ['5m'],
        mode: 'initial' as never,
        from: new Date(start),
        to: futureTo,
        now: NOW,
      });
      // The provider can only confirm up to `now`; the run is still complete
      // because requiredCoveredTo is clamped to now, not targetTo.
      expect(result.feeds[0].coverageComplete).toBe(true);
      const completion = harness.stateRepository.completionInputs[0];
      expect(completion.requiredCoveredTo.getTime()).toBe(NOW.getTime());
      const past = await harness.service.syncAsset({
        assetId: CRYPTO_ASSET.id,
        targets: ['5m'],
        mode: 'repair' as never,
        from: new Date(start),
        to: new Date(start + 2 * FIVE_MIN),
        resume: false,
        now: NOW,
      });
      expect(past.feeds[0].status).toBe('completed');
      const pastCompletion = harness.stateRepository.completionInputs.at(-1);
      expect(pastCompletion?.requiredCoveredTo.getTime()).toBe(
        start + 2 * FIVE_MIN,
      );
    });

    it('summarizes completed feeds separately from coverage-complete feeds', async () => {
      const usAsset = {
        id: 'us-1',
        symbol: 'AAPL',
        market: 'NASDAQ',
        assetType: 'us_stock',
        isActive: true,
      };
      const harness = createHarness({ assets: [CRYPTO_ASSET, usAsset] });
      const from = new Date(NOW.getTime() - 35 * DAY);
      // Crypto: full sweep → completed + coverage-complete.
      harness.binanceCandles.fetchKlinesPage.mockResolvedValue(
        binancePage({
          candles: [syntheticCandle(from.getTime())],
          providerReturnedRows: 1,
          acceptedRows: 1,
        }),
      );
      // US 5m: provider retention ends before targetFrom → the run ends
      // completed but coverage-incomplete.
      const oldestAvailable = new Date(NOW.getTime() - 20 * DAY);
      harness.fiveMinuteIngestion.fetchUsFiveMinuteCandles.mockResolvedValue({
        provider: 'kis_us_minute',
        assetId: usAsset.id,
        rangeFrom: from,
        rangeTo: NOW,
        pagesFetched: 5,
        providerReturnedRows: 100,
        acceptedRows: 80,
        rejectedRows: 0,
        duplicateRows: 0,
        candles: [syntheticCandle(oldestAvailable.getTime())],
        complete: false,
        stopReason: 'provider_exhausted',
        oldestOpenTime: oldestAvailable,
        latestOpenTime: new Date(NOW.getTime() - FIVE_MIN),
      });
      const summary = await harness.service.syncAssets({
        targets: ['5m'],
        mode: 'initial' as never,
        from,
        to: NOW,
        now: NOW,
      });
      expect(summary.totalFeeds).toBe(2);
      // completedFeeds counts normal termination only — NOT confirmed
      // coverage; the split counters expose the difference.
      expect(summary.completedFeeds).toBe(2);
      expect(summary.coverageCompleteFeeds).toBe(1);
      expect(summary.completedWithIncompleteCoverageFeeds).toBe(1);
      expect(summary.failedFeeds).toBe(0);
    });
  });
});
