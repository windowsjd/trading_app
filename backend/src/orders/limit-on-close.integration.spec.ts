import { spawnSync } from 'node:child_process';
const testDb = process.env.LIMIT_ON_CLOSE_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'Limit-on-Close actual PostgreSQL financial contract',
  () => {
    const run = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['tsx', 'scripts/limit-on-close-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 480000,
      },
    );
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    expect(run.stdout.includes('Limit-on-Close PostgreSQL PASS')).toBe(true);
  },
  490000,
);
