import { spawnSync } from 'node:child_process';
const itDb =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1' ? it : it.skip;
describe('order input policy PostgreSQL integration', () => {
  itDb(
    'keeps amount, replay, reservation and regular-session evidence consistent in General and Season',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/order-input-policy-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 120000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('order input policy db integration ok');
    },
    130000,
  );
});
