import { spawnSync } from 'node:child_process';

const itDb = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('KRX session-close recovery PostgreSQL integration', () => {
  itDb(
    'recovers dated provider closes through HTTP, PostgreSQL and both account modes',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/krx-session-close-recovery-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120000,
        },
      );
      if (result.status !== 0)
        throw new Error(`${result.stdout}\n${result.stderr}`);
      expect(result.stdout).toContain(
        'krx recovery integration ok: 5 scenarios',
      );
    },
    130000,
  );
});
