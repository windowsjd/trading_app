import { spawnSync } from 'node:child_process';
const itDb =
  process.env.SEASON_FINAL_QUALIFICATION_DB_INTEGRATION === '1' ? it : it.skip;
describe('Season final-ranking eligibility actual PostgreSQL integration', () => {
  itDb(
    'ranks only qualified participants, settles everyone, and fails closed on missing evidence',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/season-final-qualification-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain(
        'season final qualification PostgreSQL ok',
      );
    },
    310000,
  );
});
