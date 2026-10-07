import { spawnSync } from 'node:child_process';
const itDb =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1' ? it : it.skip;
describe('Atomic cross-currency wallet transfer PostgreSQL integration', () => {
  itDb(
    'proves economic parity, rollback, repricing, reservations, lifecycle and concurrency in both modes',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/wallet-fx-transfer-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240_000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('wallet FX transfer db integration ok');
    },
    250_000,
  );
});
