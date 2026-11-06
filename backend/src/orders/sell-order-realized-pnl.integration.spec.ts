import { spawnSync } from 'node:child_process';
const itDb =
  process.env.SELL_REALIZED_PNL_DB_INTEGRATION === '1' ? it : it.skip;
describe('Spot SELL per-order realized PnL on PostgreSQL', () => {
  itDb(
    'every confirmed SELL fill stores exactly the realized PnL its own transaction applied',
    () => {
      const run = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/sell-order-realized-pnl-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 300000,
        },
      );
      if (run.status !== 0) throw new Error(run.stdout + run.stderr);
      expect(run.stdout.includes('Sell realized PnL PostgreSQL PASS')).toBe(
        true,
      );
    },
    310000,
  );
});
