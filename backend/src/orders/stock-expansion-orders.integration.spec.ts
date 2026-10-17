import { spawnSync } from 'node:child_process';
const testDb =
  process.env.STOCK_EXPANSION_ORDERS_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'expanded stock universe (US 100 / KRX 70) on the existing order paths, actual PostgreSQL',
  () => {
    const run = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['tsx', 'scripts/stock-expansion-orders-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 240000,
      },
    );
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    expect(run.stdout.includes('Stock expansion orders PostgreSQL PASS')).toBe(
      true,
    );
  },
  250000,
);
