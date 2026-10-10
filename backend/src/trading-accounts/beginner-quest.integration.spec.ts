import { spawnSync } from 'node:child_process';

const itDb = process.env.BEGINNER_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('Beginner QUEST 01/02 PostgreSQL progress', () => {
  itDb(
    'derives progress only from committed standalone FX and transfer rows',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/beginner-quest-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `Beginner quest DB integration failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      expect(
        result.stdout.includes('beginner quest DB integration passed'),
      ).toBe(true);
    },
    130_000,
  );
});
