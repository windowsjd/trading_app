import { spawnSync } from 'node:child_process';

const itDb = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('Wallet Scope foundation PostgreSQL integration', () => {
  itDb(
    'preserves migration fingerprints and legacy finance with multiple USD scopes',
    () => {
      const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const prepare = spawnSync(
        command,
        ['run', '--silent', 'test:db:prepare'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      if (prepare.status !== 0) {
        throw new Error(prepare.stdout + prepare.stderr);
      }
      const result = spawnSync(
        command,
        ['tsx', 'scripts/wallet-scope-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(result.stdout + result.stderr);
      }
      expect(result.stdout).toContain('wallet scope db integration ok');
    },
    250_000,
  );
});
