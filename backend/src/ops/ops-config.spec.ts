jest.mock('../generated/prisma/client', () => ({
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_lifecycle_transition: 'season_lifecycle_transition',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
  },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpsJobName } from '../generated/prisma/client';
import { getOpsSchedulerConfig } from './ops-config';

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
    ]);
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

  it('.env.example documents the non-secret tick interval default', () => {
    const envExample = readFileSync(
      join(process.cwd(), '.env.example'),
      'utf8',
    );

    expect(envExample).toContain('SCHEDULER_TICK_INTERVAL_MS=60000');
  });
});
