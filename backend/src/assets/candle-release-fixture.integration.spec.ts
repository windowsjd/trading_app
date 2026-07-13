import { spawnSync } from 'node:child_process';

const itRelease =
  process.env.CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE === '1' ? it : it.skip;

// Full release fixture smoke: real PostgreSQL + Redis, fixture providers
// only. See scripts/candle-release-fixture-smoke.ts for the scenario list.
describe('Candle pipeline release fixture smoke', () => {
  itRelease(
    'passes every release scenario and cleans up all fixture rows/keys',
    () => {
      const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const prepare = spawnSync(command, ['run', 'test:db:prepare'], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (prepare.status !== 0) {
        throw new Error(`migrate deploy failed:\n${prepare.stderr}`);
      }
      const result = spawnSync(
        command,
        ['exec', 'tsx', 'scripts/candle-release-fixture-smoke.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240_000,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `release fixture smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
      }
      expect(result.stdout).toContain('"result": "passed"');
    },
    300_000,
  );
});
