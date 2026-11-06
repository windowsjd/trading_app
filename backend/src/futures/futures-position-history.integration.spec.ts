import { spawnSync } from 'node:child_process';
const itDb =
  process.env.FUTURES_POSITION_HISTORY_DB_INTEGRATION === '1' ? it : it.skip;
describe('futures position history (포지션 진입/종료) PostgreSQL + HTTP', () => {
  itDb(
    'pages entries and exits (reduce/close, liquidations, the Season exit) of the owner’s account only, newest first',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/futures-position-history-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain(
        'futures position history PostgreSQL + HTTP ok',
      );
    },
    150000,
  );
});
