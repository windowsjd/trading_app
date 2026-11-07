import { spawnSync } from 'node:child_process';

// Runs with the core account suites (CI sets TRADING_ACCOUNT_DB_INTEGRATION);
// the script itself refuses anything but a local disposable test database.
const itDb = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1' ? it : it.skip;

describe('AdMob SSV rewarded ads PostgreSQL integration', () => {
  itDb(
    'a session-bound, Google-signed callback redeems one top-up or reset once; nothing else applies',
    () => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/admob-ssv-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: 'test',
            ADMOB_SSV_DB_INTEGRATION: '1',
          },
          encoding: 'utf8',
          timeout: 240_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `AdMob SSV DB integration failed (${result.signal ?? result.status}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      expect(result.stdout.includes('admob ssv DB integration passed')).toBe(
        true,
      );
    },
    250_000,
  );
});
