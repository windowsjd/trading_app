import { spawnSync } from 'node:child_process';

/**
 * Multi-instance provider trade-readiness suite (real Redis, two independent
 * service/registry instances).
 *
 * Regression guard for the per-process registry: with the live-candle
 * supervisor owning the socket on one instance, every OTHER API instance used
 * to answer LIMIT_ORDER_PROVIDER_UNAVAILABLE for a perfectly subscribed asset,
 * so the same request succeeded or failed depending on which pod served it.
 *
 * A single-process unit test cannot demonstrate this, which is why the runner
 * builds two separate RedisService/registry pairs.
 */
const RUN_INTEGRATION =
  process.env.LIMIT_ORDER_SHARED_READINESS_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Provider trade readiness multi-instance Redis integration', () => {
  itIntegration(
    'answers readiness identically on a non-owner instance and fails closed everywhere else',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-shared-readiness-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_SHARED_READINESS_ENABLED: 'true',
          },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order shared readiness integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'instance B sees the readiness instance A published',
        'an unacknowledged subscription is rejected on instance B',
        'a rejected subscription is rejected on instance B',
        'a shard-capped asset is rejected on instance B',
        'a stale heartbeat is rejected',
        'a reconnect invalidates the previous generation immediately',
        'a late release from a superseded owner cannot delete the new state',
        'a Redis failure fails closed',
        'no credential or raw provider frame reaches Redis',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order shared readiness integration ok',
      );
    },
    200_000,
  );
});
