jest.mock('../generated/prisma/client', () => ({
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
  },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('.env.example documents the non-secret tick interval default', () => {
    const envExample = readFileSync(
      join(process.cwd(), '.env.example'),
      'utf8',
    );

    expect(envExample).toContain('SCHEDULER_TICK_INTERVAL_MS=60000');
  });
});
