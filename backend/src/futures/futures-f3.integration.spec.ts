import { spawnSync } from 'node:child_process';
const itDb = process.env.FUTURES_F3_DB_INTEGRATION === '1' ? it : it.skip;
describe('Futures F3 actual PostgreSQL integration', () => {
  itDb(
    'proves valuation, performance, final settlement, retries, collateral boundaries and races',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/futures-f3-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
          encoding: 'utf8',
          timeout: 300000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('futures F3 db integration ok');
    },
    310000,
  );
});
