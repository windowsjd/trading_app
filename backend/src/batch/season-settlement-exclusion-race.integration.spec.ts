import { spawnSync } from 'node:child_process';
const itDb =
  process.env.SEASON_SETTLEMENT_RACE_DB_INTEGRATION === '1' ? it : it.skip;
describe('Season settlement vs participant exclusion actual PostgreSQL integration (TC-D01)', () => {
  itDb(
    'serializes exclusion with final settlement and never publishes a stale participant set',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/season-settlement-exclusion-race-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain(
        'season settlement exclusion race PostgreSQL ok',
      );
    },
    310000,
  );
});
