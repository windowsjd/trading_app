import { spawnSync } from 'node:child_process';
const itDb = process.env.COMMUNITY_DB_INTEGRATION === '1' ? it : it.skip;
describe('community PostgreSQL + HTTP invariants', () => {
  itDb(
    'posts, anonymity, numbering, HOT, moderation, account deletion and retention',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/community-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240000,
        },
      );
      // A timeout, signal or spawn error has no exit code: name it.
      if (result.status !== 0)
        throw new Error(
          `community integration exited ${result.status ?? result.signal ?? result.error?.message}\n${result.stdout}${result.stderr}`,
        );
      expect(result.stdout).toContain('community PostgreSQL + HTTP ok');
    },
    270000,
  );
});
