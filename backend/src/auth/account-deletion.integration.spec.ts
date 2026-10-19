import { spawnSync } from 'node:child_process';

const enabled = process.env.ACCOUNT_DELETION_DB_INTEGRATION === '1';
(enabled ? describe : describe.skip)(
  'Self-service account deletion PostgreSQL',
  () => {
    it('deletes every member row in one commit, preserves settled results anonymously and serializes with trades, settlement, refresh and uploads', () => {
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['exec', 'tsx', 'scripts/account-deletion-integration.ts'],
        {
          cwd: process.cwd(),
          // The F1 Futures fixtures it builds on carry their own opt-in.
          env: {
            ...process.env,
            FUTURES_DB_INTEGRATION: '1',
            NODE_OPTIONS: '--max-old-space-size=2048',
          },
          encoding: 'utf8',
          timeout: 600_000,
          maxBuffer: 4_000_000,
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Account deletion integration failed: ${result.error?.message ?? ''}\n${result.stdout.slice(-20_000)}\n${result.stderr.slice(-20_000)}`,
        );
      expect(result.stdout).toContain(
        'account deletion PostgreSQL integration ok',
      );
    }, 610_000);
  },
);
