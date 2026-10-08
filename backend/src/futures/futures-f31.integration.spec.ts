import { spawnSync } from 'node:child_process';
const itDb = process.env.FUTURES_F31_DB_INTEGRATION === '1' ? it : it.skip;
describe('Futures F3.1 actual PostgreSQL gate', () => {
  itDb(
    'proves user fill count, immutable final reads, endAt cutoff and durable Mark retention',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/futures-f31-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, FUTURES_DB_INTEGRATION: '1' },
          encoding: 'utf8',
          timeout: 240000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('futures F3.1 db integration ok');
    },
    250000,
  );
});
