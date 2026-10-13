import { spawnSync } from 'node:child_process';
const itDb = process.env.WATCHLIST_DB_INTEGRATION === '1' ? it : it.skip;
describe('watchlist PostgreSQL + HTTP invariants', () => {
  itDb(
    'authenticates, isolates, deduplicates, caps under concurrency and persists watchlists',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/watchlist-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('watchlist PostgreSQL + HTTP ok');
    },
    210000,
  );
});
