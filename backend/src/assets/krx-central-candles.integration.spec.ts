import { spawnSync } from 'node:child_process';

const itDb =
  process.env.KRX_CENTRAL_CANDLES_DB_INTEGRATION === '1' ? it : it.skip;

describe('central KRX candle collection PostgreSQL + Redis integration', () => {
  itDb(
    'collects, audits, repairs, confirms, compacts and serves two KRX sessions without user-request provider calls',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/krx-central-candles-integration.ts'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 280000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`,
        );
      expect(
        result.stdout.includes('krx central candles integration ok:'),
      ).toBe(true);
    },
    300000,
  );
});
