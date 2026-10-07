import { spawnSync } from 'node:child_process';
const itDb = process.env.FUTURES_RISK_DB_INTEGRATION === '1' ? it : it.skip;
describe('Futures F2.1 Isolated allocated collateral boundary (PostgreSQL)', () => {
  itDb(
    'proves exact cash quanta, Cross parity, rollback and liquidation races',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/futures-isolated-boundary-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain(
        'futures F2.1 isolated boundary integration ok',
      );
    },
    250000,
  );
});
