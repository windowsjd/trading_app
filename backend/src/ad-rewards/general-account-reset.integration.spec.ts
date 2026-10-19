import { spawnSync } from 'node:child_process';

// Runs with the core account suites (CI sets TRADING_ACCOUNT_DB_INTEGRATION);
// the script itself refuses anything but a local disposable test database.
const itDb = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('General account reset PostgreSQL integration', () => {
  itDb(
    'resets atomically into a new epoch, redeems one ad event once, and keeps history',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/general-account-reset-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: 'test',
            GENERAL_ACCOUNT_RESET_DB_INTEGRATION: '1',
          },
          encoding: 'utf8',
          timeout: 240_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `General account reset DB integration failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      expect(
        result.stdout.includes('general account reset DB integration passed'),
      ).toBe(true);
    },
    250_000,
  );
});
