import { spawnSync } from 'node:child_process';
const itDb = process.env.ACTIVE_ADMIN_DB_INTEGRATION === '1' ? it : it.skip;
describe('TC-A01 active admin PostgreSQL concurrency', () => {
  itDb(
    'preserves administrators, audits and refresh sessions across real lock waits and rollback',
    () => {
      const result = spawnSync(
        process.execPath,
        [
          '--max-old-space-size=768',
          '--import',
          'tsx',
          'scripts/active-admin-race-integration.ts',
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 180000,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Child status=${result.status}, signal=${result.signal}\n${result.stdout}${result.stderr}`,
        );
      expect(result.stdout).toContain('active admin race PostgreSQL ok');
    },
    190000,
  );
});
