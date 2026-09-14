import { spawnSync } from 'node:child_process';

const itDb = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('Asset tradability and account authority PostgreSQL integration', () => {
  itDb(
    'keeps assets neutral and financial gates/read/cancel intact',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/trading-tradability-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, LIMIT_ORDER_ENABLED: 'true' },
          encoding: 'utf8',
          timeout: 120000,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Tradability integration failed.\n${result.stdout}\n${result.stderr}`,
        );
      expect(result.stdout).toContain(
        'trading tradability integration ok: 8 scenarios',
      );
    },
    130000,
  );
});
