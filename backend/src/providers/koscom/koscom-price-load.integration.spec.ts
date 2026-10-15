import { spawnSync } from 'node:child_process';

const itDb =
  process.env.KOSCOM_PRICE_LOAD_DB_INTEGRATION === '1' ? it : it.skip;

describe('KOSCOM 100-stock price slots (L1 smoke) PostgreSQL + Redis', () => {
  itDb(
    'collects 100 stocks in 6 batches per slot across two instances, survives a minute burst and an owner crash, and keeps prices fresh',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/koscom-price-load-integration.ts'],
        {
          cwd: process.cwd(),
          // The smoke profile is the script's default (no injected faults
          // beyond latency, the burst and the crash).
          env: process.env,
          encoding: 'utf8',
          timeout: 200000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`,
        );
      expect(result.stdout.includes('{"l1":')).toBe(true);
    },
    220000,
  );
});
