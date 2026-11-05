import { spawnSync } from 'node:child_process';
const testDb =
  process.env.PENDING_ORDER_MODIFY_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'Pending order/setting changes (설정 변경) actual PostgreSQL contract',
  () => {
    const run = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['tsx', 'scripts/pending-order-modification-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 480000,
      },
    );
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    expect(run.stdout).toContain('Pending order modification PostgreSQL PASS');
  },
  490000,
);
