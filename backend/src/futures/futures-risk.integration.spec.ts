import { spawnSync } from 'node:child_process';
const itDb = process.env.FUTURES_RISK_DB_INTEGRATION === '1' ? it : it.skip;
describe('Futures F2 actual PostgreSQL financial integration', () => {
  itDb(
    'proves risk, atomic liquidation, bankruptcy, transfers, lifecycle, races and rollback',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/futures-risk-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('futures F2 db integration ok');
    },
    310000,
  );
});
