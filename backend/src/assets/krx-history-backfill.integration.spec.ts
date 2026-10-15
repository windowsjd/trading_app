import { spawnSync } from 'node:child_process';

const itDb =
  process.env.KRX_HISTORY_BACKFILL_DB_INTEGRATION === '1' ? it : it.skip;

describe('KRX history backfill (L10-B) PostgreSQL + Redis integration', () => {
  itDb(
    'backfills 1d 576 and 4h 97 sessions from a mock KOSCOM, resumes after a stop, holds a contradicting session and passes G4-H',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/krx-history-backfill-integration.ts'],
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
      expect(result.stdout.includes('"l10b":"ok"')).toBe(true);
    },
    300000,
  );
});
