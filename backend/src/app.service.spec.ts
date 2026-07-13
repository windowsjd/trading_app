jest.mock('./generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
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

import { AppService } from './app.service';
import { readLiveCandleConfig } from './assets/live-candle.config';
import { LiveCandleHealthService } from './assets/live-candle-health.service';

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
      const krx = result.data.marketCalendar.markets.find(
        (entry: { market: string }) => entry.market === 'KRX',
      );
      // Operators can read exactly which year datasets must be added.
      expect(krx.missingYears).toEqual([2028]);
    } finally {
      delete process.env.MARKET_CALENDAR_REQUIRED_FROM_YEAR;
      delete process.env.MARKET_CALENDAR_REQUIRED_THROUGH_YEAR;
    }
  });

  it('is ready when calendars cover the required range and nothing is degraded', async () => {
    delete process.env.REDIS_URL;
    const service = new AppService({
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as never);
    const result = await service.getReadiness();
    expect(result.data.status).toBe('ready');
    expect(result.data.reasons).toEqual([]);
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
});
