import { spawnSync } from 'node:child_process';
const itDb = process.env.INQUIRIES_DB_INTEGRATION === '1' ? it : it.skip;
describe('inquiries PostgreSQL + HTTP invariants', () => {
  itDb(
    'authenticates, validates, owns, deduplicates, rate-limits and answers inquiries',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/inquiries-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120000,
        },
      );
      // A timeout, signal or spawn error has no exit code: name it.
      if (result.status !== 0)
        throw new Error(
          `inquiries integration exited ${result.status ?? result.signal ?? result.error?.message}\n${result.stdout}${result.stderr}`,
        );
      expect(result.stdout).toContain('inquiries PostgreSQL + HTTP ok');
    },
    150000,
  );
});
