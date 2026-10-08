import { spawnSync } from 'node:child_process';
const testDb = process.env.FUTURES_LIMIT_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'Futures Limit Entry actual PostgreSQL contract',
  () => {
    const run = spawnSync(
      'pnpm',
      ['tsx', 'scripts/futures-limit-entry-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 240000,
      },
    );
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    expect(run.stdout).toContain('Futures Limit PostgreSQL PASS');
  },
  250000,
);
