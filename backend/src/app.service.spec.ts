jest.mock('./generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
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

  it('reports PostgreSQL loss as unavailable', async () => {
    delete process.env.REDIS_URL;
    const service = new AppService({
      $queryRaw: jest.fn().mockRejectedValue(new Error('db down')),
    } as never);
    await expect(service.getReadiness()).resolves.toMatchObject({
      success: false,
      data: { status: 'unavailable', database: 'unavailable' },
    });
  });
});
