import { spawnSync } from 'node:child_process';

const itDb =
  process.env.ASSET_PRICE_SNAPSHOT_RETENTION_DB_INTEGRATION === '1'
    ? it
    : it.skip;

describe('asset price snapshot retention PostgreSQL integration', () => {
  itDb(
    'deletes exactly the unreferenced, superseded, out-of-retention rows and nothing that is evidence',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/asset-price-snapshot-retention-integration.ts'],
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
        result.stdout.includes(
          'asset price snapshot retention integration ok:',
        ),
      ).toBe(true);
    },
    180000,
  );
});
