import { spawnSync } from 'node:child_process';
const itDb = process.env.COMPLETED_TRADES_DB_INTEGRATION === '1' ? it : it.skip;
describe('completed trades (수익 공유) PostgreSQL + HTTP', () => {
  itDb(
    'reads the owner’s completed trades with the friend policy figures, stored-execution prices and the general reset epoch',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/completed-trades-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('completed trades PostgreSQL + HTTP ok');
    },
    150000,
  );
});
