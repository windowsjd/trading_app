import { spawnSync } from 'node:child_process';
const itDb =
  process.env.VALUATION_CONSISTENCY_DB_INTEGRATION === '1' ? it : it.skip;
describe('Valuation snapshot consistency actual PostgreSQL integration (TC-D05)', () => {
  itDb(
    'values one committed account state while Spot, FX, transfer and Futures commands commit mid-read',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/valuation-snapshot-consistency-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain(
        'valuation snapshot consistency PostgreSQL ok',
      );
    },
    310000,
  );
});
