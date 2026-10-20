import { spawnSync } from 'node:child_process';

const enabled = process.env.DATA_RETENTION_DB_INTEGRATION === '1';
(enabled ? describe : describe.skip)('Data retention PostgreSQL', () => {
  it('deletes only rows past each retention boundary, in bounded locked batches', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/data-retention-integration.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=768' },
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 256_000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Data retention integration failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
      );
    expect(result.stdout).toContain('data retention PostgreSQL ok');
  }, 95_000);
});
