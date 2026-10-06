import { spawnSync } from 'node:child_process';

const itDb =
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION === '1' ? it : it.skip;
describe('Spot cash provenance and USD transfer PostgreSQL integration', () => {
  itDb(
    'preserves legacy orders and proves current Spot, transfer and lifecycle invariants',
    () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', 'scripts/spot-wallet-transfer-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240_000,
        },
      );
      if (result.status !== 0) throw new Error(result.stdout + result.stderr);
      expect(result.stdout).toContain('spot wallet transfer db integration ok');
    },
    250_000,
  );
});
