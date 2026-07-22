import { spawnSync } from 'node:child_process';

/**
 * Event-boundary concurrency suite (real PostgreSQL, real advisory locks).
 *
 * Opt-in like the other database suites so `pnpm test` needs no
 * infrastructure; CI sets the flag with a migrated DATABASE_URL.
 *
 * This is the regression guard for the shared-`pg.Client` defect: the poller
 * and the path-B candle worker share one Nest provider instance, and a boolean
 * `held` flag could not make them mutually exclusive because PostgreSQL
 * session advisory locks are re-entrant within a single session. Both would be
 * granted, and the unbalanced release leaked the lock permanently.
 */
const RUN_INTEGRATION =
  process.env.LIMIT_ORDER_BOUNDARY_CONCURRENCY_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Limit order match boundary concurrency integration', () => {
  itIntegration(
    'serializes concurrent acquisitions on one service instance and leaves no residual lock',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-boundary-concurrency-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order boundary concurrency integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'concurrent acquire on one service instance serializes on the database',
        'poller and candle worker on one instance never share a session',
        'a create transaction acquires immediately after both leases release',
        'a killed worker session releases the boundary for the next worker',
        'releasing a lease twice never unlocks a lock it no longer owns',
        'the boundary leaves no residual advisory lock',
        'lockInTransaction works through the real Prisma driver adapter',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order boundary concurrency integration ok',
      );
    },
    200_000,
  );
});
