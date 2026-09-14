import { spawnSync } from 'node:child_process';

const itDb = process.env.ORDER_EXECUTE_DB_INTEGRATION === '1' ? it : it.skip;

describe('Market and FX fee-pinning PostgreSQL contract', () => {
  itDb(
    'pins both modes across fee changes, repricing, legacy compatibility and replay',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/trading-fee-pinning-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180000,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Fee-pinning integration failed.\n${result.stdout}\n${result.stderr}`,
        );
      expect(result.stdout).toContain(
        'trading fee-pinning integration ok: 16 scenarios',
      );
    },
    190000,
  );
});
