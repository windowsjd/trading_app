import { spawnSync } from 'node:child_process';

const itDb =
  process.env.CRYPTO_ORDER_BOOK_HISTORY_DB_INTEGRATION === '1' ? it : it.skip;

describe('crypto order book history PostgreSQL integration', () => {
  itDb(
    'stores one book per product and minute across writers and restarts, and keeps exactly 14 days',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/crypto-order-book-history-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 170000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`,
        );
      expect(
        result.stdout.includes('crypto order book history integration ok:'),
      ).toBe(true);
    },
    180000,
  );
});
