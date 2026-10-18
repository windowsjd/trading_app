import { spawnSync } from 'node:child_process';

const enabled = process.env.AUTH_DB_SMOKE === '1';
(enabled ? describe : describe.skip)(
  'Email verification and recovery PostgreSQL',
  () => {
    it('enforces ownership, atomic completion, revocation and shared abuse limits with mocked delivery', () => {
      const result = spawnSync(
        'pnpm',
        ['exec', 'tsx', 'scripts/auth-email-integration.ts'],
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
          `Auth email integration failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
        );
      expect(result.stdout).toContain('auth email PostgreSQL integration ok');
    }, 95_000);
  },
);
