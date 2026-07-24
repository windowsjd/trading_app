import { spawnSync } from 'node:child_process';

/**
 * IDEMPOTENT REPLAY suite for limit Create (real PostgreSQL).
 *
 * Covers the two things a mock cannot show, because both are about rows that
 * already exist:
 *
 *   ORDERING — a create that already COMMITTED must be replayed before the
 *   feature flag and before the create-service wiring are consulted, so an
 *   emergency rollback or a partially wired instance cannot withhold a
 *   response the system already produced, and cannot produce a second order or
 *   a second cash reservation.
 *
 *   SCOPE — the replay lookup must select exactly the order the database's own
 *   uniqueness would, so the same idempotencyKey reused in a later season
 *   (which the schema permits) resolves to that season's own order instead of
 *   conflicting.
 */
const RUN_INTEGRATION =
  process.env.LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Limit order idempotent replay integration', () => {
  itIntegration(
    'replays a committed create ahead of every gate, and only ever the caller own order',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-idempotent-replay-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, LIMIT_ORDER_ENABLED: 'true' },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order idempotent replay integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'a committed create replays while the feature flag is off',
        'a committed create replays on an instance with no create service',
        'a committed create replays while every health gate is failing',
        'a committed create replays after the season ended',
        'the same key in two seasons replays each season own order',
        'a different request under the same quote is a conflict',
        'another user can neither replay nor probe this order',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order idempotent replay integration ok',
      );
    },
    200_000,
  );
});
