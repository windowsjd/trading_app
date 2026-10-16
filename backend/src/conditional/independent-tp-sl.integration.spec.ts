import { spawnSync } from 'node:child_process';
const testDb =
  process.env.INDEPENDENT_TP_SL_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'Independent TP/SL (Futures settings, entry plans, OCO retirement) actual PostgreSQL contract',
  () => {
    const run = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['tsx', 'scripts/independent-tp-sl-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 600000,
      },
    );
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    expect(run.stdout).toContain('independent TP/SL db integration ok');
  },
  610000,
);
