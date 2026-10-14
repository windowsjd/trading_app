import { spawnSync } from 'node:child_process';
const testDb =
  process.env.FUTURES_CONDITIONAL_ENTRY_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'Futures Conditional Entry actual PostgreSQL contract',
  () => {
    const run = spawnSync(
      'pnpm',
      ['tsx', 'scripts/futures-conditional-entry-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 420000,
      },
    );
    if (run.status !== 0) throw new Error(run.stdout + run.stderr);
    expect(run.stdout).toContain('Futures conditional entry PostgreSQL PASS');
  },
  430000,
);
