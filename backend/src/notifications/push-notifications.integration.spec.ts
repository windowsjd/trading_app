import { spawnSync } from 'node:child_process';
const itDb =
  process.env.PUSH_NOTIFICATIONS_DB_INTEGRATION === '1' ? it : it.skip;
describe('push notifications PostgreSQL integration', () => {
  itDb(
    'derives each committed event once, isolates users and never touches financial rows',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/push-notifications-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('push notifications PostgreSQL ok');
    },
    190000,
  );
});
