import { spawnSync } from 'node:child_process';
const itDb = process.env.FRIENDS_DB_INTEGRATION === '1' ? it : it.skip;
describe('friends PostgreSQL + HTTP invariants', () => {
  itDb(
    'enforces relationship, privacy, migration defaults and ranking isolation',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/friends-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('friends PostgreSQL + HTTP ok');
    },
    150000,
  );
});
