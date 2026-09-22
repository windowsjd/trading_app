import { spawnSync } from 'node:child_process';

const itDb = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('ranking generation PostgreSQL integration', () => {
  itDb(
    'keeps publication monotonic and each API response on one MVCC snapshot',
    () => {
      const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      // Same opt-in/migrate-only preparation as the existing account DB suite.
      for (const args of [
        ['run', '--silent', 'test:db:prepare'],
        ['tsx', 'scripts/ranking-consistency-integration.ts'],
      ]) {
        const result = spawnSync(pnpm, args, {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180_000,
        });
        if (result.status !== 0) {
          throw new Error(result.stdout + result.stderr);
        }
        if (args[0] === 'tsx') {
          expect(result.stdout).toContain('ranking consistency PostgreSQL ok');
        }
      }
    },
    240_000,
  );
});
