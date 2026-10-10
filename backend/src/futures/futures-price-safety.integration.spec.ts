import { spawnSync } from 'node:child_process';
const testDb =
  process.env.FUTURES_PRICE_SAFETY_DB_INTEGRATION === '1' ? it : it.skip;
testDb(
  'readiness CLI and Last retention preserve actual PostgreSQL financial evidence',
  () => {
    const run = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/futures-price-safety-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
        encoding: 'utf8',
        timeout: 300000,
      },
    );
    if (run.status !== 0)
      throw new Error((run.stdout + run.stderr).slice(-16000));
    expect(run.stdout).toContain('Futures price safety PostgreSQL PASS');
  },
  310000,
);
