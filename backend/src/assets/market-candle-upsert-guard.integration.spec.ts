import { spawnSync } from 'node:child_process';
const testDb =
  process.env.MARKET_CANDLE_UPSERT_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'market_candles upsert skips unchanged confirmed closed bars and keeps every informative write',
  () => {
    const run = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/market-candle-upsert-guard-integration.ts'],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120000,
      },
    );
    if (run.status !== 0)
      throw new Error((run.stdout + run.stderr).slice(-16000));
    expect(run.stdout).toContain('market candle upsert guard PostgreSQL ok');
  },
  130000,
);
