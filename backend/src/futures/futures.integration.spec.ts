import { spawnSync } from 'node:child_process';
const itDb = process.env.FUTURES_DB_INTEGRATION === '1' ? it : it.skip;
describe('Futures F1 actual PostgreSQL financial integration', () => {
  itDb(
    'proves General/Season lifecycle, evidence, fees, collateral, rollback and races',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/futures-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240_000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('futures F1 db integration ok');
    },
    250_000,
  );
});
