jest.mock('../generated/prisma/client', () => ({
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpsJobName } from '../generated/prisma/client';
import { getOpsSchedulerConfig } from './ops-config';
import { OpsConfigError } from './ops-config';

describe('getOpsSchedulerConfig', () => {
  it('defaults scheduler disabled, dry-run-compatible timing to 60000ms', () => {
    const config = getOpsSchedulerConfig({});

    expect(config.enabled).toBe(false);
    expect(config.tickIntervalMs).toBe(60_000);
    expect(config.lockTtlSeconds).toBe(600);
    expect(config.maxAttempts).toBe(1);
    expect(Object.values(config.jobs)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(config.providerIntervalsSeconds[OpsJobName.provider_fx_ingest]).toBe(
      3600,
    );
    expect(
      config.providerIntervalsSeconds[OpsJobName.provider_binance_ingest],
    ).toBe(60);
    expect(
      config.providerIntervalsSeconds[OpsJobName.provider_kis_ingest],
    ).toBe(60);
    expect(config.providerIngestionRunOnStartup).toBe(false);
    expect(config.providerKisMaxSnapshots).toBe(500);
    expect(config.providerKisPriceIngestionMode).toBe('websocket_trade');
    expect(config.marketCandleRetention).toEqual({
      enabled: false,
      retentionDays: 35,
      batchSize: 5000,
      hour: 4,
      minute: 0,
      runOnStartup: false,
    });
  });

  it('validates retention schedule settings strictly', () => {
    const config = getOpsSchedulerConfig({
      SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED: 'true',
      MARKET_CANDLE_5M_RETENTION_DAYS: '40',
      MARKET_CANDLE_RETENTION_BATCH_SIZE: '2500',
      SCHEDULER_MARKET_CANDLE_RETENTION_HOUR: '3',
      SCHEDULER_MARKET_CANDLE_RETENTION_MINUTE: '30',
      SCHEDULER_MARKET_CANDLE_RETENTION_RUN_ON_STARTUP: 'true',
    });
    expect(config.enabled).toBe(true);
    expect(config.jobs[OpsJobName.market_candle_retention]).toBe(true);
    expect(config.marketCandleRetention).toMatchObject({
      enabled: true,
      retentionDays: 40,
      batchSize: 2500,
      hour: 3,
      minute: 30,
      runOnStartup: true,
    });

    for (const env of [
      { SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED: 'maybe' },
      { MARKET_CANDLE_5M_RETENTION_DAYS: '30' },
      { MARKET_CANDLE_RETENTION_BATCH_SIZE: '10001' },
      { SCHEDULER_MARKET_CANDLE_RETENTION_HOUR: '24' },
      { SCHEDULER_MARKET_CANDLE_RETENTION_MINUTE: '60' },
      { SCHEDULER_MARKET_CANDLE_RETENTION_RUN_ON_STARTUP: 'sometimes' },
    ]) {
      expect(() => getOpsSchedulerConfig(env)).toThrow(OpsConfigError);
    }
  });

  it('reads SCHEDULER_TICK_INTERVAL_MS and falls back on invalid values', () => {
    expect(
      getOpsSchedulerConfig({
        SCHEDULER_TICK_INTERVAL_MS: '15000',
      }).tickIntervalMs,
    ).toBe(15_000);
    expect(
      getOpsSchedulerConfig({
        SCHEDULER_TICK_INTERVAL_MS: '0',
      }).tickIntervalMs,
    ).toBe(60_000);
  });

  it('supports requested scheduler aliases and second-based intervals', () => {
    const config = getOpsSchedulerConfig({
      ENABLE_RANKING_SCHEDULER: 'true',
      ENABLE_SEASON_LIFECYCLE_SCHEDULER: 'true',
      ENABLE_SEASON_SETTLEMENT_SCHEDULER: 'true',
      RANKING_REFRESH_INTERVAL_SECONDS: '30',
    });

    expect(config.enabled).toBe(true);
    expect(config.tickIntervalMs).toBe(30_000);
    expect(config.jobs[OpsJobName.season_ranking_generation]).toBe(true);
    expect(config.jobs[OpsJobName.season_lifecycle_transition]).toBe(true);
    expect(config.jobs[OpsJobName.season_settlement]).toBe(true);
  });

  it('enables KIS provider job with the scheduler flag or alias', () => {
    expect(
      getOpsSchedulerConfig({
        SCHEDULER_PROVIDER_KIS_ENABLED: 'true',
      }).jobs[OpsJobName.provider_kis_ingest],
    ).toBe(true);

    const aliasConfig = getOpsSchedulerConfig({
      ENABLE_PROVIDER_KIS_SCHEDULER: 'true',
    });

    expect(aliasConfig.enabled).toBe(true);
    expect(aliasConfig.jobs[OpsJobName.provider_kis_ingest]).toBe(true);
  });

  it('parses provider intervals and falls back on invalid values', () => {
    const config = getOpsSchedulerConfig({
      SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS: '7200',
      SCHEDULER_PROVIDER_BINANCE_INTERVAL_SECONDS: '30',
      SCHEDULER_PROVIDER_KIS_INTERVAL_SECONDS: '15',
      SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS: '250',
      SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP: 'true',
    });

    expect(config.providerIntervalsSeconds).toMatchObject({
      [OpsJobName.provider_fx_ingest]: 7200,
      [OpsJobName.provider_binance_ingest]: 30,
      [OpsJobName.provider_kis_ingest]: 15,
    });
    expect(config.providerKisMaxSnapshots).toBe(250);
    expect(config.providerIngestionRunOnStartup).toBe(true);

    const fallbackConfig = getOpsSchedulerConfig({
      SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS: '0',
      SCHEDULER_PROVIDER_BINANCE_INTERVAL_SECONDS: 'not-a-number',
      SCHEDULER_PROVIDER_KIS_INTERVAL_SECONDS: '-1',
      SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS: '',
      PROVIDER_INGESTION_MAX_SNAPSHOTS: '125',
    });

    expect(
      fallbackConfig.providerIntervalsSeconds[OpsJobName.provider_fx_ingest],
    ).toBe(3600);
    expect(
      fallbackConfig.providerIntervalsSeconds[
        OpsJobName.provider_binance_ingest
      ],
    ).toBe(60);
    expect(
      fallbackConfig.providerIntervalsSeconds[OpsJobName.provider_kis_ingest],
    ).toBe(60);
    expect(fallbackConfig.providerKisMaxSnapshots).toBe(125);
  });

  it('defaults KIS scheduler price ingestion to websocket_trade with REST fallback opt-in', () => {
    expect(getOpsSchedulerConfig({}).providerKisPriceIngestionMode).toBe(
      'websocket_trade',
    );
    expect(
      getOpsSchedulerConfig({
        KIS_PRICE_INGESTION_MODE: 'rest_current_price',
      }).providerKisPriceIngestionMode,
    ).toBe('rest_current_price');
    expect(
      getOpsSchedulerConfig({
        KIS_PRICE_INGESTION_MODE: 'invalid',
      }).providerKisPriceIngestionMode,
    ).toBe('websocket_trade');
  });

  it('.env.example documents the non-secret tick interval default', () => {
    const envExample = readFileSync(
      join(process.cwd(), '.env.example'),
      'utf8',
    );

    expect(envExample).toContain('SCHEDULER_TICK_INTERVAL_MS=60000');
    expect(envExample).toContain('SCHEDULER_PROVIDER_KIS_ENABLED=false');
    expect(envExample).toContain('KIS_PRICE_INGESTION_MODE=websocket_trade');
    expect(envExample).toContain('SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS=3600');
    expect(envExample).toContain(
      'SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP=false',
    );
  });
});
