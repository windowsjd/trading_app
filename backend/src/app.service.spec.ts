jest.mock('./generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
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
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    provider_kis_ingest: 'provider_kis_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_lifecycle_transition: 'season_lifecycle_transition',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
    market_candle_retention: 'market_candle_retention',
    market_candle_sync: 'market_candle_sync',
    market_candle_reconciliation: 'market_candle_reconciliation',
  },
}));
jest.mock('./realtime/live-candle-pubsub.service', () => ({
  LiveCandlePubSubService: class LiveCandlePubSubService {},
}));

import {
  AppService,
  MARKET_SESSION_OVERRIDE_READINESS_REASONS,
} from './app.service';
import { readLiveCandleConfig } from './assets/live-candle.config';
import { LiveCandleHealthService } from './assets/live-candle-health.service';
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
  recordMarketSessionOverrideRefreshFailure,
  resetMarketSessionOverrideStoreForTest,
} from './orders/market-calendar/market-session-override.store';

describe('AppService candle readiness', () => {
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('reports Redis/provider loss as degraded without taking the HTTP API down', async () => {
    process.env.REDIS_URL = 'redis://fixture';
    const health = new LiveCandleHealthService();
    health.updateProvider('binance', {
      owner: true,
      state: 'reconnecting',
    });
    const service = new AppService(
      { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as never,
      undefined,
      undefined,
      { ping: jest.fn().mockRejectedValue(new Error('redis down')) } as never,
      health,
      { getStatus: jest.fn().mockReturnValue('unavailable') } as never,
      undefined,
      { ...readLiveCandleConfig({}), enabled: true, binanceEnabled: true },
    );
    const result = await service.getReadiness();
    expect(result).toMatchObject({
      success: true,
      data: {
        status: 'degraded',
        database: 'ok',
        redis: 'unavailable',
        liveCandle: { enabled: true, pubSub: 'unavailable' },
      },
    });
  });

  it('reports PostgreSQL loss as unavailable with CANDLE_DB_UNAVAILABLE', async () => {
    delete process.env.REDIS_URL;
    const service = new AppService({
      $queryRaw: jest.fn().mockRejectedValue(new Error('db down')),
    } as never);
    const result = await service.getReadiness();
    expect(result).toMatchObject({
      success: false,
      data: { status: 'unavailable', database: 'unavailable' },
    });
    expect(result.data.reasons).toContain('CANDLE_DB_UNAVAILABLE');
    // Readiness itself stays HTTP 200; the alert view must page on it.
    expect(result.data.alerts).toEqual(['CANDLE_DB_UNAVAILABLE']);
    const alerts = await service.getReadinessAlerts();
    expect(alerts.httpStatus).toBe(503);
    expect(alerts.body.data.status).toBe('unavailable');
  });

  it('degrades with MARKET_CALENDAR_COVERAGE_MISSING when required years lack datasets', async () => {
    delete process.env.REDIS_URL;
    process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR = '2026';
    process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2028';
    try {
      const service = new AppService({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      } as never);
      const result = await service.getReadiness();
      expect(result.data.status).toBe('degraded');
      expect(result.data.reasons).toContain('MARKET_CALENDAR_COVERAGE_MISSING');
      // Missing and provisional years degrade simultaneously and separately.
      expect(result.data.reasons).toContain('MARKET_CALENDAR_PROVISIONAL');
      const krx = result.data.marketCalendar.markets.find(
        (entry: { market: string }) => entry.market === 'KRX',
      );
      // Operators can read exactly which year datasets must be added.
      expect(krx.missingYears).toEqual([2028]);
      expect(krx.provisionalYears).toEqual([2027]);
    } finally {
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
    }
  });

  it('degrades with MARKET_CALENDAR_PROVISIONAL while KRX 2027 awaits the official notice', async () => {
    delete process.env.REDIS_URL;
    process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR = '2026';
    process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2027';
    try {
      const service = new AppService({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      } as never);
      const result = await service.getReadiness();
      // Provisional data degrades readiness (never unavailable) and is
      // reported per market/year so operators know exactly what to verify.
      expect(result.data.status).toBe('degraded');
      expect(result.data.reasons).toContain('MARKET_CALENDAR_PROVISIONAL');
      expect(result.data.reasons).not.toContain(
        'MARKET_CALENDAR_COVERAGE_MISSING',
      );
      expect(result.data.marketCalendar.complete).toBe(true);
      expect(result.data.marketCalendar.productionReady).toBe(false);
      const krx = result.data.marketCalendar.markets.find(
        (entry: { market: string }) => entry.market === 'KRX',
      );
      expect(krx.provisionalYears).toEqual([2027]);
      expect(krx.auditedYears).toEqual([2026]);
      const us = result.data.marketCalendar.markets.find(
        (entry: { market: string }) => entry.market === 'US',
      );
      expect(us.provisionalYears).toEqual([]);
      expect(us.auditedYears).toEqual([2026, 2027]);
    } finally {
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
    }
  });

  it('is ready when the required range only spans audited calendar years', async () => {
    delete process.env.REDIS_URL;
    // A 2026 release that does not require 2027 pins the requirement to the
    // audited year; the provisional KRX 2027 dataset then has no readiness
    // effect. This narrows the REQUIREMENT — it never relabels provisional
    // data as audited.
    process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR = '2026';
    process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2026';
    try {
      const service = new AppService({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      } as never);
      const result = await service.getReadiness();
      expect(result.data.status).toBe('ready');
      expect(result.data.reasons).toEqual([]);
      expect(result.data.marketCalendar.productionReady).toBe(true);
    } finally {
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
    }
  });

  describe('trade freshness (LIVE_PROVIDER_STALE)', () => {
    // 2026-07-15 is an ordinary KRX trading day (Wednesday) in the audited
    // 2026 calendar: 05:00Z = 14:00 KST (in session), 13:00Z = 22:00 KST
    // (after close).
    const inKrxSession = new Date('2026-07-15T05:00:00.000Z');
    const outOfKrxSession = new Date('2026-07-15T13:00:00.000Z');

    const createService = (health: LiveCandleHealthService) =>
      new AppService(
        {
          $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        } as never,
        undefined,
        undefined,
        undefined,
        health,
        { getStatus: jest.fn().mockReturnValue('connected') } as never,
        undefined,
        { ...readLiveCandleConfig({}), enabled: true, binanceEnabled: true },
      );

    beforeEach(() => {
      delete process.env.REDIS_URL;
    });

    it('degrades readiness when Binance trades go stale, using tradeStaleThresholdMs', async () => {
      const health = new LiveCandleHealthService();
      health.updateProvider('binance', {
        owner: true,
        state: 'connected',
        delayed: false,
        eventLagMs: 60_000, // above the 30s default tradeStaleThresholdMs
      });
      const result = await createService(health).getReadiness(inKrxSession);
      expect(result.data.reasons).toContain('LIVE_PROVIDER_STALE');
      expect(result.data.status).toBe('degraded');
    });

    it('keeps a fresh provider out of LIVE_PROVIDER_STALE', async () => {
      const health = new LiveCandleHealthService();
      health.updateProvider('binance', {
        owner: true,
        state: 'connected',
        delayed: false,
        eventLagMs: 1_000,
      });
      const result = await createService(health).getReadiness(inKrxSession);
      expect(result.data.reasons).not.toContain('LIVE_PROVIDER_STALE');
    });

    it.each(['kis', 'koscom'] as const)(
      'exempts a quiet %s feed outside the KRX regular session',
      async (provider) => {
        const health = new LiveCandleHealthService();
        health.updateProvider(provider, {
          owner: true,
          state: 'connected',
          delayed: false,
          eventLagMs: 999_999,
        });
        const stale = await createService(health).getReadiness(inKrxSession);
        expect(stale.data.reasons).toContain('LIVE_PROVIDER_STALE');
        const quiet = await createService(health).getReadiness(outOfKrxSession);
        expect(quiet.data.reasons).not.toContain('LIVE_PROVIDER_STALE');
      },
    );

    it('excludes the delayed US feed from real-time staleness checks', async () => {
      const health = new LiveCandleHealthService();
      health.updateProvider('kis', {
        owner: true,
        state: 'connected',
        delayed: true,
        eventLagMs: 999_999,
      });
      const result = await createService(health).getReadiness(inKrxSession);
      expect(result.data.reasons).not.toContain('LIVE_PROVIDER_STALE');
    });
  });

  it('flags live streaming without reconciliation as LIVE_RECONCILIATION_REQUIRED', async () => {
    delete process.env.REDIS_URL;
    const service = new AppService(
      { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as never,
      undefined,
      undefined,
      undefined,
      new LiveCandleHealthService(),
      { getStatus: jest.fn().mockReturnValue('connected') } as never,
      undefined,
      { ...readLiveCandleConfig({}), enabled: true, binanceEnabled: true },
    );
    const result = await service.getReadiness();
    expect(result.data.reasons).toContain('LIVE_RECONCILIATION_REQUIRED');
    expect(result.data.status).toBe('degraded');
  });

  describe('market session override runtime readiness', () => {
    // Pin the calendar requirement to an audited year so only the override
    // runtime state drives the readiness outcome in these tests.
    beforeEach(() => {
      delete process.env.REDIS_URL;
      process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR = '2026';
      process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2026';
    });

    afterEach(() => {
      resetMarketSessionOverrideStoreForTest();
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
    });

    const createService = () =>
      new AppService({
        $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      } as never);

    it('is ready after the first snapshot load succeeds', async () => {
      markMarketSessionOverrideStoreRequired();
      applyMarketSessionOverrideSnapshot([], new Date());
      const result = await createService().getReadiness();
      expect(result.data.status).toBe('ready');
      expect(result.data.reasons).toEqual([]);
      expect(result.data.marketSessionOverride).toMatchObject({
        mode: 'required',
        state: 'ready',
        loaded: true,
        lastRefreshFailedAt: null,
      });
    });

    it('degrades with NOT_LOADED before the first load completes', async () => {
      markMarketSessionOverrideStoreRequired();
      const result = await createService().getReadiness();
      // Static calendar coverage alone must never report the stock calendar
      // as ready while the override snapshot has not loaded (fail-closed).
      expect(result.data.status).toBe('degraded');
      expect(result.data.reasons).toContain(
        MARKET_SESSION_OVERRIDE_READINESS_REASONS.notLoaded,
      );
      expect(result.data.marketSessionOverride).toMatchObject({
        state: 'not_loaded',
        loaded: false,
      });
    });

    it('degrades with UNAVAILABLE on a cold-start load failure', async () => {
      markMarketSessionOverrideStoreRequired();
      recordMarketSessionOverrideRefreshFailure(new Date());
      const result = await createService().getReadiness();
      expect(result.data.status).toBe('degraded');
      expect(result.data.reasons).toContain(
        MARKET_SESSION_OVERRIDE_READINESS_REASONS.unavailable,
      );
      expect(result.data.marketSessionOverride).toMatchObject({
        state: 'unavailable',
        loaded: false,
      });
      // The HTTP API stays up (crypto is unaffected); only degraded.
      expect(result.success).toBe(true);
    });

    it('degrades with LAST_KNOWN_GOOD when a refresh fails after a load', async () => {
      markMarketSessionOverrideStoreRequired();
      applyMarketSessionOverrideSnapshot([], new Date());
      recordMarketSessionOverrideRefreshFailure(new Date());
      const result = await createService().getReadiness();
      expect(result.data.status).toBe('degraded');
      expect(result.data.reasons).toContain(
        MARKET_SESSION_OVERRIDE_READINESS_REASONS.lastKnownGood,
      );
      expect(result.data.reasons).not.toContain(
        MARKET_SESSION_OVERRIDE_READINESS_REASONS.unavailable,
      );
      expect(result.data.marketSessionOverride).toMatchObject({
        state: 'last_known_good',
        loaded: true,
      });
    });

    it('recovers to ready once a later refresh succeeds', async () => {
      markMarketSessionOverrideStoreRequired();
      applyMarketSessionOverrideSnapshot([], new Date());
      recordMarketSessionOverrideRefreshFailure(new Date());
      applyMarketSessionOverrideSnapshot([], new Date());
      const result = await createService().getReadiness();
      expect(result.data.status).toBe('ready');
      expect(result.data.reasons).toEqual([]);
      expect(result.data.marketSessionOverride).toMatchObject({
        state: 'ready',
      });
    });

    it('reports passthrough (no reasons) when the loader is not registered', async () => {
      const result = await createService().getReadiness();
      expect(result.data.status).toBe('ready');
      expect(result.data.marketSessionOverride).toMatchObject({
        mode: 'passthrough',
        state: 'passthrough',
      });
    });
  });

  it('publishes the Tiingo trial status without changing readiness', async () => {
    delete process.env.REDIS_URL;
    process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR = '2026';
    process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2026';
    try {
      const tiingo = {
        getStatus: jest.fn().mockReturnValue({
          provider: 'tiingo',
          state: 'enabled',
          persistence: 'disabled',
          lastFailure: { stage: 'rest', code: 'TIINGO_UNAUTHORIZED', at: null },
        }),
      };
      const service = new AppService(
        {
          $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tiingo as never,
      );
      const result = await service.getReadiness();
      expect(result.data.status).toBe('ready');
      expect(result.data.reasons).toEqual([]);
      expect(result.data.tiingo).toMatchObject({
        provider: 'tiingo',
        persistence: 'disabled',
      });
    } finally {
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
    }
  });
  describe('market candle retention readiness', () => {
    const at = new Date('2026-10-16T00:00:00Z');
    const build = (latest: unknown, succeeded: unknown) => {
      const runs = {
        findLatestRunForJob: jest.fn().mockResolvedValue(latest),
        findLatestSucceededRunForJob: jest.fn().mockResolvedValue(succeeded),
        findLatestSucceededReconciliationRun: jest.fn(),
      };
      const service = new AppService(
        {
          $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        runs as never,
      );
      return { service, runs };
    };
    beforeEach(() => {
      delete process.env.REDIS_URL;
      process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR = '2026';
      process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2026';
      process.env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED = 'true';
    });
    afterEach(() => {
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
      delete process.env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED;
    });
    const hoursAgo = (h: number) => new Date(+at - h * 3_600_000);

    it('reads nothing while the job is disabled', async () => {
      delete process.env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED;
      const { service, runs } = build(null, null);
      const result = await service.getReadiness(at);
      expect(result.data.marketCandleRetention.state).toBe('disabled');
      expect(runs.findLatestRunForJob).not.toHaveBeenCalled();
    });

    it.each([
      ['pending before the first run', null, null, 'pending', []],
      [
        'fresh after a run in the last 26 h',
        { status: 'succeeded', startedAt: hoursAgo(20) },
        { status: 'succeeded', finishedAt: hoursAgo(20) },
        'fresh',
        [],
      ],
      [
        'failed when its latest run failed',
        { status: 'failed', startedAt: hoursAgo(1) },
        { status: 'succeeded', finishedAt: hoursAgo(20) },
        'failed',
        ['MARKET_CANDLE_RETENTION_FAILED'],
      ],
      [
        'stale without a success in 26 h',
        { status: 'succeeded', startedAt: hoursAgo(30) },
        { status: 'succeeded', finishedAt: hoursAgo(30) },
        'stale',
        ['MARKET_CANDLE_RETENTION_STALE'],
      ],
    ])('is %s', async (_label, latest, succeeded, state, reasons) => {
      const result = await build(latest, succeeded).service.getReadiness(at);
      expect(result.data.marketCandleRetention.state).toBe(state);
      expect(
        result.data.reasons.filter((r) => r.startsWith('MARKET_CANDLE_')),
      ).toEqual(reasons);
      // A daily housekeeping job is a readiness note, not a page.
      expect(result.data.alerts).toEqual([]);
    });
  });

  describe('collector, retention and storage health', () => {
    const at = new Date('2026-10-16T00:00:00Z');
    const build = (sources: {
      mark?: unknown;
      markRetention?: unknown;
      lastRetention?: unknown;
      storage?: unknown;
    }) =>
      new AppService(
        {
          $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { getStatus: jest.fn().mockReturnValue(sources.mark) } as never,
        {
          getStatus: jest.fn().mockReturnValue(sources.markRetention),
        } as never,
        {
          getStatus: jest.fn().mockReturnValue(sources.lastRetention),
        } as never,
        { getStatus: jest.fn().mockReturnValue(sources.storage) } as never,
      );
    const unhealthy = (enabled: boolean) => ({
      mark: {
        enabled,
        staleTargets: 2,
        consecutivePersistFailures: 3,
        lastPersistFailure: {
          kind: 'disk_full',
          at: new Date(+at - 60000).toISOString(),
        },
      },
      markRetention: {
        enabled,
        failing: true,
        backlog: false,
        lastFailureKind: 'statement_timeout',
        lastFailedAt: at.toISOString(),
      },
      lastRetention: {
        enabled,
        failing: false,
        backlog: true,
        lastFailureKind: null,
        lastFailedAt: null,
      },
      storage: {
        enabled,
        level: 'action_required',
        daysUntil80Percent: 3,
      },
    });
    beforeEach(() => {
      delete process.env.REDIS_URL;
      process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR = '2026';
      process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2026';
    });
    afterEach(() => {
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
    });

    it('adds no reason while the features are disabled', async () => {
      const result = await build(unhealthy(false)).getReadiness(at);
      expect(result.data.status).toBe('ready');
      expect(result.data.reasons).toEqual([]);
      expect(result.data.futuresMark?.enabled).toBe(false);
    });

    it('reports each unhealthy signal with a fixed reason and stays serving', async () => {
      const result = await build(unhealthy(true)).getReadiness(at);
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('degraded');
      expect(result.data.reasons).toEqual([
        'FUTURES_MARK_STALE',
        'FUTURES_MARK_PERSIST_FAILING',
        'FUTURES_MARK_RETENTION_FAILING',
        'FUTURES_LAST_PRICE_RETENTION_BACKLOG',
        'DB_DISK_FULL',
        'DB_STORAGE_ACTION_REQUIRED',
        'DB_STORAGE_RUNWAY_SHORT',
      ]);
    });

    it('lists only operator reasons as alerts; the alert view answers 503 until they clear', async () => {
      const unhealthyResult = await build(unhealthy(true)).getReadiness(at);
      expect(unhealthyResult.data.alerts).toEqual(unhealthyResult.data.reasons);
      const alerting = await build(unhealthy(true)).getReadinessAlerts(at);
      expect(alerting.httpStatus).toBe(503);
      expect(alerting.body.success).toBe(false);
      expect(alerting.body.data.alerts).toContain('DB_DISK_FULL');
      const healthy = await build({}).getReadinessAlerts(at);
      expect(healthy.httpStatus).toBe(200);
      expect(healthy.body.data.alerts).toEqual([]);
    });

    it('keeps a calendar-only degradation out of the alerts', async () => {
      process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR = '2099';
      const result = await build({}).getReadinessAlerts(at);
      expect(result.body.data.status).toBe('degraded');
      expect(result.httpStatus).toBe(200);
      expect(result.body.data.alerts).toEqual([]);
    });

    it('alerts on a stale storage sample instead of showing its last level', async () => {
      const result = await build({
        storage: {
          enabled: true,
          level: 'ok',
          daysUntil80Percent: null,
          sampleStale: true,
        },
      }).getReadiness(at);
      expect(result.data.reasons).toEqual(['DB_STORAGE_SAMPLE_STALE']);
      expect(result.data.alerts).toEqual(['DB_STORAGE_SAMPLE_STALE']);
    });

    it('reports the crypto order-book history writer and retention, alerting on failures and disk full', async () => {
      const history = (recorder: unknown, retention: unknown) =>
        new AppService(
          {
            $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
          } as never,
          ...(Array.from({ length: 14 }, () => undefined) as []),
          { getStatus: jest.fn().mockReturnValue(recorder) } as never,
          { getStatus: jest.fn().mockReturnValue(retention) } as never,
        );
      const failingRecorder = (enabled: boolean) => ({
        enabled,
        consecutiveWriteFailures: 3,
        lastWriteFailure: {
          kind: 'disk_full',
          at: new Date(+at - 60000).toISOString(),
        },
      });
      const failingRetention = (enabled: boolean) => ({
        enabled,
        failing: true,
        backlog: true,
        lastFailureKind: 'statement_timeout',
        lastFailedAt: at.toISOString(),
      });
      const off = await history(
        failingRecorder(false),
        failingRetention(false),
      ).getReadiness(at);
      expect(off.data.reasons).toEqual([]);
      const on = await history(
        failingRecorder(true),
        failingRetention(true),
      ).getReadinessAlerts(at);
      expect(on.httpStatus).toBe(503);
      expect(on.body.data.alerts).toEqual([
        'CRYPTO_ORDER_BOOK_HISTORY_PERSIST_FAILING',
        'CRYPTO_ORDER_BOOK_RETENTION_FAILING',
        'CRYPTO_ORDER_BOOK_RETENTION_BACKLOG',
        'DB_DISK_FULL',
      ]);
      const readiness = await history(failingRecorder(true), null).getReadiness(
        at,
      );
      expect(readiness.data.cryptoOrderBookHistory.recorder).toMatchObject({
        enabled: true,
        consecutiveWriteFailures: 3,
      });
      expect(readiness.data.cryptoOrderBookHistory.retention).toBeNull();
    });

    it('drops DB_DISK_FULL ten minutes after the last disk-full write failure', async () => {
      const sources = unhealthy(true);
      sources.mark.lastPersistFailure.at = new Date(+at - 600001).toISOString();
      const result = await build(sources).getReadiness(at);
      expect(result.data.reasons.includes('DB_DISK_FULL')).toBe(false);
    });

    it.each([
      ['warning', 'DB_STORAGE_WARNING'],
      ['critical', 'DB_STORAGE_CRITICAL'],
    ])('maps storage level %s to %s', async (level, reason) => {
      const result = await build({
        storage: { enabled: true, level, daysUntil80Percent: null },
      }).getReadiness(at);
      expect(result.data.reasons).toEqual([reason]);
    });
  });
});
