import { spawnSync } from 'node:child_process';

/**
 * Multi-instance provider trade-readiness suite (real PostgreSQL + Redis, two
 * independent service/registry instances).
 *
 * Two regression families:
 *
 * 1. Per-process readiness: with the live-candle supervisor owning the socket
 *    on one instance, every OTHER API instance used to answer
 *    LIMIT_ORDER_PROVIDER_UNAVAILABLE for a perfectly subscribed asset — the
 *    same request succeeded or failed depending on which pod served it. The
 *    suite drives the WHOLE Quote→Create financial flow on the non-owner
 *    instance, down to the reservation and the submitted order row.
 *
 * 2. Ownership fencing: publishing the shared view is derived from the REAL
 *    provider owner lease (the supervisor's Redis lock), verified inside
 *    Redis on every write. A local registry claim, a wrong lease token, a
 *    stale fencing epoch, a replaced owner with a faster clock, and an
 *    old-generation socket ack are all refused.
 *
 * A single-process unit test cannot demonstrate either family.
 */
const RUN_INTEGRATION =
  process.env.LIMIT_ORDER_SHARED_READINESS_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Provider trade readiness multi-instance Redis integration', () => {
  itIntegration(
    'fences publishing on the real owner lease and completes the non-owner create flow',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-shared-readiness-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_SHARED_READINESS_ENABLED: 'true',
            // The create-path scenarios drive the real gates, which are inert
            // unless the feature flags are on.
            LIMIT_ORDER_ENABLED: 'true',
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
          },
          encoding: 'utf8',
          timeout: 240_000,
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
        'readiness keys share the owner lease cluster slot',
        'instance B sees the readiness instance A published under the live lease',
        'an unacknowledged subscription is rejected on instance B',
        'a rejected subscription is rejected on instance B',
        'a shard-capped asset is rejected on instance B',
        'a stale heartbeat is rejected',
        'a reconnect invalidates the previous generation immediately',
        'a publisher without the Redis lease cannot publish despite a local owner claim',
        'a wrong lease token is refused even with the current epoch',
        'a stale fencing epoch is refused even with the live lease token',
        'an old owner cannot republish after takeover even with a newer clock',
        'an old-generation subscription ack cannot ready the current generation',
        'a late release from the replaced owner cannot delete the new state',
        'a non-owner instance completes the whole Quote and Create financial flow',
        'a non-owner create fails closed with no reservation once the owner disappears',
        'a Redis failure fails closed',
        'no credential or raw provider frame reaches Redis',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order shared readiness integration ok',
      );
    },
    260_000,
  );
});
