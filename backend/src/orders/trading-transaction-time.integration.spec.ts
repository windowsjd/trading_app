import { spawnSync } from 'node:child_process';

const itDb =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1' ? it : it.skip;

describe('Common trading transaction-time PostgreSQL policy', () => {
  itDb(
    'checks market/FX/Path A/B boundaries, authorization races, timestamps and replay in both modes',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/trading-transaction-time-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_ENABLED: 'true',
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
          },
          encoding: 'utf8',
          timeout: 180000,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Trading transaction-time integration failed.\n${result.stdout}\n${result.stderr}`,
        );
      expect(result.stdout).toContain(
        'trading transaction-time integration ok',
      );
    },
    190000,
  );
});
