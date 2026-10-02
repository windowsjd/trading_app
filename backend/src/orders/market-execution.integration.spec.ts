import { spawnSync } from 'node:child_process';

const itDb = process.env.MARKET_EXECUTION_DB_INTEGRATION === '1' ? it : it.skip;
describe('One-shot market execution PostgreSQL integration', () => {
  itDb(
    'settles actual fills, replays once, and rolls back every financial stage',
    () => {
      const result = spawnSync(
        'pnpm',
        ['exec', 'tsx', 'scripts/market-execution-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
      if (result.status !== 0)
        throw new Error(`${result.stdout}\n${result.stderr}`);
      expect(result.stdout).toContain('market execution integration ok');
    },
    130_000,
  );
});
