jest.mock('../../src/generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    Prisma: { Decimal: runtime.Decimal, DbNull: Symbol('Prisma.DbNull') },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
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
jest.mock('../../src/prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));
jest.mock('../../src/redis/redis.service', () => ({
  RedisService: jest.fn(),
}));
jest.mock('./load-runtime-env', () => ({
  loadRuntimeEnv: jest.fn(),
  requireDatabaseUrl: jest.fn(),
  formatDatabaseTarget: () => 'fixture database',
}));

import { Logger } from '@nestjs/common';
import { main } from '../candle-baseline-sync';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { MarketCandleSyncService } from '../../src/assets/market-candle-sync.service';
import { MarketCandleSyncStateRepository } from '../../src/assets/market-candle-sync-state.repository';
import { MarketCandlesRepository } from '../../src/assets/market-candles.repository';
import { MarketCandleBackfillLockService } from '../../src/assets/market-candle-backfill-lock.service';
import * as syncConfig from '../../src/assets/market-candle-sync.config';
import { KisUsMinuteAdapter } from '../../src/providers/kis/candles/kis-us-minute.adapter';
import { KisOverseasPeriodAdapter } from '../../src/providers/kis/candles/kis-overseas-period.adapter';
import { BinanceCandleIngestionService } from '../../src/providers/binance/binance-candle.ingestion.service';
import { getAssetTradingStatus } from '../../src/orders/market-hours.policy';
import {
  findFirstMarketSessionOnOrAfter,
  findLastMarketSessionOfWeek,
  inspectMarketSessionsInRange,
  resolveMarketSession,
  resolveStockMarketDataUpperBound,
  resolveStockMarketSessionState,
} from '../../src/orders/market-calendar.policy';
import {
  MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS,
  MarketSessionOverrideLoaderService,
} from '../../src/orders/market-calendar/market-session-override.loader.service';
import {
  getMarketSessionOverrideRuntimeStatus,
  markMarketSessionOverrideStoreRequired,
  recordMarketSessionOverrideRefreshFailure,
  resetMarketSessionOverrideStoreForTest,
  type MarketSessionOverrideEntry,
} from '../../src/orders/market-calendar/market-session-override.store';
import { KoscomCandleAdapter } from '../../src/providers/koscom/koscom-candle.adapter';
import { KoscomClient } from '../../src/providers/koscom/koscom.client';
import { KoscomMarketMapService } from '../../src/providers/koscom/koscom-market-map.service';
import type { MarketCandleSyncSummary } from '../../src/assets/market-candle-sync.types';

const NOW = new Date('2026-07-13T23:00:00Z');
const STOCKS = [
  {
    id: 'krx',
    symbol: '005930',
    assetType: 'domestic_stock' as const,
    market: 'KOSPI',
    calendarMarket: 'KRX' as const,
    isActive: true,
  },
  {
    id: 'us',
    symbol: 'AAPL',
    assetType: 'us_stock' as const,
    market: 'NASDAQ',
    calendarMarket: 'US' as const,
    isActive: true,
  },
];
const CRYPTO = {
  id: 'crypto',
  symbol: 'BTC',
  assetType: 'crypto' as const,
  market: 'BINANCE',
  isActive: true,
};

function override(
  market: 'KRX' | 'US',
  overrideType: MarketSessionOverrideEntry['overrideType'],
  localDate = '2026-07-13',
): MarketSessionOverrideEntry {
  return {
    market,
    localDate,
    overrideType,
    openTime: overrideType === 'custom' ? '110000' : null,
    closeTime: overrideType === 'custom' ? '130000' : null,
    reason: 'operator fixture',
  };
}

// Real calendar decisions, including the period feed's first/last sessions
// and provider upper bound. Only the DB transport is replaced in these tests.
function decisions(localDate = '20260713') {
  return STOCKS.map((asset) => ({
    session: resolveMarketSession(asset.calendarMarket, localDate),
    state: resolveStockMarketSessionState(asset, NOW),
    range: inspectMarketSessionsInRange(
      asset,
      new Date(NOW.getTime() - 86_400_000),
      NOW,
    ),
    upperBound: resolveStockMarketDataUpperBound(asset, NOW),
    first: findFirstMarketSessionOnOrAfter(
      asset.calendarMarket,
      localDate,
      localDate,
    ),
    lastOfWeek: findLastMarketSessionOfWeek(asset.calendarMarket, localDate),
  }));
}

describe('standalone candle baseline calendar bootstrap', () => {
  const prisma = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    marketSessionOverride: { findMany: jest.fn() },
    asset: { findMany: jest.fn() },
  };
  const redis = { onModuleDestroy: jest.fn() };

  function harness() {
    const sync = jest.spyOn(MarketCandleSyncService.prototype, 'syncAssets');
    const lock = jest
      .spyOn(MarketCandleBackfillLockService.prototype, 'acquire')
      .mockResolvedValue({ acquired: true, handle: {} } as never);
    jest
      .spyOn(MarketCandleBackfillLockService.prototype, 'renewIfDue')
      .mockResolvedValue(true);
    jest
      .spyOn(MarketCandleBackfillLockService.prototype, 'release')
      .mockResolvedValue(true);
    const states = MarketCandleSyncStateRepository.prototype;
    jest.spyOn(states, 'findResumable').mockResolvedValue(null);
    const create = jest
      .spyOn(states, 'createRunning')
      .mockImplementation((input) =>
        Promise.resolve({
          ...input,
          id: 'checkpoint',
          cursorJson: null,
          coveredFrom: null,
          coveredTo: null,
        } as never),
      );
    const progress = jest
      .spyOn(states, 'recordPageSuccess')
      .mockResolvedValue(true);
    const complete = jest
      .spyOn(states, 'markCompleted')
      .mockResolvedValue(true);
    const fail = jest.spyOn(states, 'markFailed').mockResolvedValue(true);
    jest.spyOn(states, 'findById').mockResolvedValue(null);
    const write = jest
      .spyOn(MarketCandlesRepository.prototype, 'upsertMany')
      .mockResolvedValue({ writtenCount: 0 });
    const latest = jest
      .spyOn(MarketCandlesRepository.prototype, 'findLatest')
      .mockResolvedValue(null);
    jest
      .spyOn(MarketCandlesRepository.prototype, 'findRange')
      .mockResolvedValue([]);
    const providers = [
      jest.spyOn(KoscomCandleAdapter.prototype, 'fetchDomesticOneMinuteRows'),
      jest.spyOn(KisUsMinuteAdapter.prototype, 'fetchUsFiveMinuteRows'),
      jest.spyOn(KoscomCandleAdapter.prototype, 'fetchPeriodPage'),
      jest.spyOn(KisOverseasPeriodAdapter.prototype, 'fetchPeriodPage'),
      jest.spyOn(BinanceCandleIngestionService.prototype, 'fetchKlinesPage'),
    ];
    for (const provider of providers) {
      provider.mockRejectedValue(new Error('Unexpected provider call'));
    }
    return {
      sync,
      lock,
      create,
      progress,
      complete,
      fail,
      write,
      latest,
      providers,
    };
  }

  async function summary(
    sync: jest.SpiedFunction<MarketCandleSyncService['syncAssets']>,
  ): Promise<MarketCandleSyncSummary> {
    return (await sync.mock.results[0].value) as MarketCandleSyncSummary;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.clearAllMocks();
    resetMarketSessionOverrideStoreForTest();
    prisma.$connect.mockResolvedValue(undefined);
    prisma.$disconnect.mockResolvedValue(undefined);
    prisma.marketSessionOverride.findMany.mockReset().mockResolvedValue([]);
    prisma.asset.findMany.mockReset().mockResolvedValue(STOCKS);
    redis.onModuleDestroy.mockResolvedValue(undefined);
    jest.mocked(PrismaService).mockImplementation(() => prisma as never);
    jest.mocked(RedisService).mockImplementation(() => redis as never);
    const config = syncConfig.readMarketCandleSyncConfig({});
    jest
      .spyOn(syncConfig, 'readMarketCandleSyncConfig')
      .mockReturnValue(config);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    resetMarketSessionOverrideStoreForTest();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    { name: 'empty snapshot', rows: [], date: '20260713' },
    {
      name: 'CLOSED',
      rows: [override('KRX', 'closed'), override('US', 'closed')],
      date: '20260713',
    },
    {
      name: 'CUSTOM',
      rows: [override('KRX', 'custom'), override('US', 'custom')],
      date: '20260713',
    },
    {
      name: 'REGULAR cancelling static New Year closures',
      rows: [
        override('KRX', 'regular', '2026-01-01'),
        override('US', 'regular', '2026-01-01'),
      ],
      date: '20260101',
    },
  ])(
    'matches production calendar decisions for $name',
    async ({ rows, date }) => {
      const h = harness();
      const staticDecisions = decisions(date);
      prisma.marketSessionOverride.findMany.mockResolvedValue(rows);
      const productionLoader = new MarketSessionOverrideLoaderService(
        prisma as never,
      );
      let productionDecisions: ReturnType<typeof decisions>;
      try {
        await productionLoader.onModuleInit();
        productionDecisions = decisions(date);
      } finally {
        await productionLoader.onModuleDestroy();
      }
      resetMarketSessionOverrideStoreForTest();

      await expect(main(['--dry-run', '--days', '1'])).resolves.toBe(0);
      expect(decisions(date)).toEqual(productionDecisions!);
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        mode: 'required',
        state: 'ready',
        loaded: true,
        activeOverrideCount: rows.length,
      });
      expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        select: {
          market: true,
          localDate: true,
          overrideType: true,
          openTime: true,
          closeTime: true,
          reason: true,
        },
      });
      if (rows.length === 0) expect(decisions(date)).toEqual(staticDecisions);
      if (rows[0]?.overrideType === 'closed') {
        expect(decisions(date).map((decision) => decision.session)).toEqual([
          null,
          null,
        ]);
        expect(
          staticDecisions.every((decision) => decision.session !== null),
        ).toBe(true);
      }
      if (rows[0]?.overrideType === 'custom') {
        expect(
          decisions(date).map((decision) => decision.session?.openTime),
        ).toEqual([
          new Date('2026-07-13T02:00:00Z'),
          new Date('2026-07-13T15:00:00Z'),
        ]);
        expect(decisions(date).map((decision) => decision.upperBound)).toEqual([
          new Date('2026-07-13T04:00:00Z'),
          new Date('2026-07-13T17:00:00Z'),
        ]);
      }
      if (rows[0]?.overrideType === 'regular') {
        expect(
          staticDecisions.every((decision) => decision.session === null),
        ).toBe(true);
        expect(
          decisions(date).map((decision) => decision.session?.closeTime),
        ).toEqual([
          new Date('2026-01-01T06:30:00Z'),
          new Date('2026-01-01T21:00:00Z'),
        ]);
      }
      expect(h.sync).toHaveBeenCalledTimes(1);
    },
  );

  it('waits for the initial snapshot before discovering assets or syncing', async () => {
    const h = harness();
    let resolveSnapshot!: (rows: MarketSessionOverrideEntry[]) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    prisma.marketSessionOverride.findMany.mockImplementationOnce(() => {
      readStarted();
      return new Promise<MarketSessionOverrideEntry[]>((resolve) => {
        resolveSnapshot = resolve;
      });
    });
    const command = main(['--dry-run']);
    await started;
    expect(getMarketSessionOverrideRuntimeStatus().state).toBe('not_loaded');
    expect(resolveStockMarketSessionState(STOCKS[0], NOW)?.state).toBe(
      'calendar_unavailable',
    );
    expect(h.sync).not.toHaveBeenCalled();
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    resolveSnapshot([]);
    await expect(command).resolves.toBe(0);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it('keeps production polling and last-known-good semantics until sync cleanup', async () => {
    const h = harness();
    let finishAssetRead!: () => void;
    let assetReadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      assetReadStarted = resolve;
    });
    prisma.asset.findMany.mockImplementationOnce(() => {
      assetReadStarted();
      return new Promise<typeof STOCKS>((resolve) => {
        finishAssetRead = () => resolve(STOCKS);
      });
    });
    const command = main(['--dry-run']);
    await started;
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([
      override('KRX', 'closed'),
    ]);
    await jest.advanceTimersByTimeAsync(
      MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS,
    );
    expect(resolveMarketSession('KRX', '20260713')).toBeNull();
    prisma.marketSessionOverride.findMany.mockRejectedValueOnce(
      new Error('transient'),
    );
    await jest.advanceTimersByTimeAsync(
      MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS,
    );
    expect(getMarketSessionOverrideRuntimeStatus().state).toBe(
      'last_known_good',
    );
    expect(resolveMarketSession('KRX', '20260713')).toBeNull();
    finishAssetRead();
    await expect(command).resolves.toBe(0);
    expect((await summary(h.sync)).failedFeeds).toBe(0);
    expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops calendar polling before Prisma disconnect even when sync throws', async () => {
    const h = harness();
    h.sync.mockRejectedValueOnce(new Error('sync failure'));
    const destroy = jest.spyOn(
      MarketSessionOverrideLoaderService.prototype,
      'onModuleDestroy',
    );
    await expect(main(['--apply'])).rejects.toThrow('sync failure');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$disconnect.mock.invocationCallOrder[0],
    );
    expect(redis.onModuleDestroy).toHaveBeenCalledTimes(1);
  });

  it.each(['initial', 'repair'])(
    'honors CLOSED for KRX/US 5m/1d/1w in %s sync',
    async (mode) => {
      // Keep both exchanges on July 13; daily buckets also inspect the last
      // local date even when its regular session has not opened yet.
      jest.setSystemTime(new Date('2026-07-13T14:00:00Z'));
      const h = harness();
      prisma.marketSessionOverride.findMany.mockResolvedValue([
        override('KRX', 'closed'),
        override('US', 'closed'),
      ]);
      await expect(
        main([
          '--apply',
          '--mode',
          mode,
          '--days',
          '1',
          '--target',
          '5m',
          '--target',
          '1d',
          '--target',
          '1w',
        ]),
      ).resolves.toBe(0);
      const result = await summary(h.sync);
      expect(result.totalFeeds).toBe(6);
      expect(result.coverageCompleteFeeds).toBe(6);
      for (const feed of result.assets.flatMap((asset) => asset.feeds)) {
        expect(feed).toMatchObject({
          stopReason: 'expected_no_data',
          status: 'completed',
          coverageComplete: true,
          completionReason: 'confirmed_empty',
          writtenRows: 0,
        });
      }
      for (const provider of h.providers)
        expect(provider).not.toHaveBeenCalled();
      expect(h.write).not.toHaveBeenCalled();
    },
  );

  it.each(STOCKS)(
    'honors CLOSED for $calendarMarket incremental 5m sync',
    async (stock) => {
      const now = new Date(
        stock.calendarMarket === 'KRX'
          ? '2026-07-13T02:30:00Z'
          : '2026-07-13T16:30:00Z',
      );
      jest.setSystemTime(now);
      const h = harness();
      prisma.asset.findMany.mockResolvedValue([stock]);
      prisma.marketSessionOverride.findMany.mockResolvedValue([
        override(stock.calendarMarket, 'closed'),
      ]);
      h.latest.mockResolvedValue({
        openTime: new Date(now.getTime() - 60 * 60_000),
      } as never);
      await expect(main(['--apply', '--mode', 'incremental'])).resolves.toBe(0);
      expect((await summary(h.sync)).assets[0].feeds[0]).toMatchObject({
        stopReason: 'expected_no_data',
        coverageComplete: true,
      });
      for (const provider of h.providers)
        expect(provider).not.toHaveBeenCalled();
    },
  );

  it('uses CUSTOM close for the real KRX minute adapter provider cursor', async () => {
    jest.setSystemTime(new Date('2026-07-13T08:00:00Z'));
    const h = harness();
    h.providers[0].mockRestore();
    prisma.asset.findMany.mockResolvedValue([STOCKS[0]]);
    prisma.marketSessionOverride.findMany.mockResolvedValue([
      override('KRX', 'custom'),
    ]);
    jest
      .spyOn(KoscomMarketMapService.prototype, 'resolve')
      .mockResolvedValue('kospi');
    const request = jest
      .spyOn(KoscomClient.prototype, 'get')
      .mockResolvedValue({
        result: { isuSrtCd: '005930', hisLists: [] },
        receivedAt: NOW,
      });

    await expect(main(['--apply', '--days', '1'])).resolves.toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toMatchObject({
      inqStrtDd: '20260713',
      endTm: '1300',
    });
    expect((await summary(h.sync)).assets[0].feeds[0].coverageComplete).toBe(
      false,
    );
  });

  it.each(['--apply', '--dry-run'])(
    'aborts %s on initial load failure, keeping stocks fail-closed',
    async (flag) => {
      const h = harness();
      prisma.asset.findMany.mockResolvedValue([...STOCKS, CRYPTO]);
      prisma.marketSessionOverride.findMany.mockRejectedValue(
        new Error('DB unavailable'),
      );
      await expect(main([flag])).rejects.toThrow('calendar_unavailable');
      expect(getMarketSessionOverrideRuntimeStatus()).toMatchObject({
        mode: 'required',
        state: 'unavailable',
        loaded: false,
      });
      for (const stock of STOCKS) {
        expect(resolveStockMarketSessionState(stock, NOW)?.state).toBe(
          'calendar_unavailable',
        );
        expect(resolveStockMarketDataUpperBound(stock, NOW)).toBeNull();
      }
      expect(getAssetTradingStatus(CRYPTO, NOW)).toEqual({ tradable: true });
      expect(h.sync).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.write).not.toHaveBeenCalled();
      expect(RedisService).not.toHaveBeenCalled();
      expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['initial', 'incremental', 'repair'])(
    'keeps %s dry-run free of provider, candle and checkpoint writes',
    async (mode) => {
      const h = harness();
      prisma.asset.findMany.mockResolvedValue([...STOCKS, CRYPTO]);
      prisma.marketSessionOverride.findMany.mockResolvedValue([
        override('KRX', 'custom'),
      ]);
      await expect(
        main([
          '--dry-run',
          '--mode',
          mode,
          '--target',
          '5m',
          '--target',
          '1d',
          '--target',
          '1w',
        ]),
      ).resolves.toBe(0);
      expect((await summary(h.sync)).totalFeeds).toBe(9);
      for (const provider of h.providers)
        expect(provider).not.toHaveBeenCalled();
      for (const write of [
        h.lock,
        h.write,
        h.create,
        h.progress,
        h.complete,
        h.fail,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(1);
      expect(redis.onModuleDestroy).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps Binance 5m/1d/1w sync independent of stock CLOSED overrides', async () => {
    const h = harness();
    prisma.asset.findMany.mockResolvedValue([CRYPTO]);
    prisma.marketSessionOverride.findMany.mockResolvedValue([
      override('KRX', 'closed'),
      override('US', 'closed'),
    ]);
    h.providers[4].mockResolvedValue({
      state: 'ok',
      candles: [],
      providerReturnedRows: 0,
      acceptedRows: 0,
      rejectedRows: 0,
      duplicateRows: 0,
      oldestOpenTime: null,
      latestOpenTime: null,
      lastCloseTime: null,
    } as never);
    await expect(
      main([
        '--apply',
        '--days',
        '1',
        '--target',
        '5m',
        '--target',
        '1d',
        '--target',
        '1w',
      ]),
    ).resolves.toBe(0);
    expect(h.providers[4]).toHaveBeenCalledTimes(3);
    expect(
      (await summary(h.sync)).assets[0].feeds.every(
        (feed) => feed.stopReason !== 'calendar_unavailable',
      ),
    ).toBe(true);
  });

  it.each(['not_loaded', 'unavailable'])(
    'keeps crypto candle sync independent of a %s stock calendar',
    async (state) => {
      const h = harness();
      prisma.asset.findMany.mockResolvedValue([CRYPTO]);
      await main(['--dry-run']);
      const service = h.sync.mock.contexts[0] as MarketCandleSyncService;
      resetMarketSessionOverrideStoreForTest();
      markMarketSessionOverrideStoreRequired();
      if (state === 'unavailable')
        recordMarketSessionOverrideRefreshFailure(NOW);
      expect(resolveStockMarketSessionState(STOCKS[0], NOW)?.state).toBe(
        'calendar_unavailable',
      );
      h.providers[4].mockResolvedValue({
        state: 'ok',
        candles: [],
        providerReturnedRows: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        duplicateRows: 0,
        oldestOpenTime: null,
        latestOpenTime: null,
        lastCloseTime: null,
      } as never);
      const result = await service.syncAssets({
        targets: ['5m', '1d', '1w'],
        now: NOW,
      });
      expect(result.failedFeeds).toBe(0);
      expect(h.providers[4]).toHaveBeenCalledTimes(3);
      expect(getMarketSessionOverrideRuntimeStatus().state).toBe(state);
    },
  );

  it('leaves --report as PostgreSQL coverage reads without calendar/Redis/provider bootstrap', async () => {
    const h = harness();
    const init = jest.spyOn(
      MarketSessionOverrideLoaderService.prototype,
      'onModuleInit',
    );
    prisma.marketSessionOverride.findMany.mockRejectedValue(
      new Error('unused'),
    );
    const coverage = jest
      .spyOn(MarketCandleSyncStateRepository.prototype, 'findCandleCoverage')
      .mockResolvedValue({
        startsAtRequestedFrom: true,
        hasInteriorGap: false,
        contiguousCoveredTo: NOW,
        newestCompletedAt: NOW,
      });
    await expect(main(['--report'])).resolves.toBe(0);
    expect(coverage).toHaveBeenCalledTimes(2);
    expect(init).not.toHaveBeenCalled();
    expect(prisma.marketSessionOverride.findMany).not.toHaveBeenCalled();
    expect(getMarketSessionOverrideRuntimeStatus().state).toBe('passthrough');
    expect(RedisService).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
});
