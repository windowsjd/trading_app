import { spawnSync } from 'node:child_process';
const itDb = process.env.FUTURES_TWO_WAY_DB_INTEGRATION === '1' ? it : it.skip;
describe('Futures two-way positions and leverage changes on PostgreSQL', () => {
  itDb(
    'merges each direction, keeps the other apart and changes leverage only as approved',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/futures-two-way-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300_000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('futures two-way db integration ok');
    },
    310_000,
  );
});
