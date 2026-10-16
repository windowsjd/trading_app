import { spawnSync } from 'node:child_process';
const testDb =
  process.env.LIMIT_ON_CLOSE_US_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'US Limit-on-Close (Tiingo end-of-day close) actual PostgreSQL financial contract',
  () => {
    const run = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['tsx', 'scripts/limit-on-close-us-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 540000,
      },
    );
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    expect(run.stdout.includes('US Limit-on-Close PostgreSQL PASS')).toBe(true);
  },
  550000,
);
