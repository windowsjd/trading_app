import { spawnSync } from 'node:child_process';

/**
 * Phase-3 PostgreSQL + Redis suite. Opt-in like the other database suites so
 * `pnpm test` needs no infrastructure; CI sets the flag with a migrated
 * DATABASE_URL and a live REDIS_URL.
 */
const RUN_INTEGRATION = process.env.LIMIT_ORDER_PHASE3_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Limit order phase 3 PostgreSQL + Redis integration', () => {
  itIntegration(
    'enforces the event boundary, path B matching, races and throughput',
    () => {
      const suffix = `${process.pid}-${Date.now()}`;
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-phase3-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
            LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
            LIMIT_ORDER_EVENT_STREAM_KEY: `limit-order:phase3:${suffix}`,
            LIMIT_ORDER_EVENT_CONSUMER_GROUP: `limit-order-phase3:${suffix}`,
            LIMIT_ORDER_EVENT_BLOCK_MS: '250',
            LIMIT_ORDER_EVENT_MAXLEN: '5000',
            LIMIT_ORDER_PENDING_IDLE_MS: '5000',
            LIMIT_ORDER_MATCHER_HEARTBEAT_INTERVAL_MS: '500',
            LIMIT_ORDER_MATCHER_HEALTH_MAX_AGE_MS: '3000',
          },
          encoding: 'utf8',
          timeout: 300_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order phase 3 integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'boundary blocks a create while the poller holds it',
        'boundary blocks the poller while a create holds it',
        'boundary is released when the worker session dies',
        'path B fills a submitted order at the limit price',
        'path B excludes the partially elapsed first candle',
        'path B ignores orders with no eligibility boundary',
        'path B rejects open, incomplete and invalid candles',
        'path B skips a candle whose close is after season end',
        'path B is idempotent across repeated sweeps',
        'path B re-runs a crashed sweep without double filling',
        'path A wins the race and path B skips the order',
        'path B wins the race and path A skips the order',
        'cancel and path B each win exactly one ordering',
        'exclusion and path B each win exactly one ordering',
        'season end and path B each win exactly one ordering',
        'matcher health gate fails closed on backlog and retention',
        'throughput sweep performs no per-event asset lookup',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      // The throughput line is the load report CI keeps in its job log.
      expect(result.stdout).toContain('limit_order_publisher_throughput');
      expect(result.stdout).toContain(
        'limit order phase3 postgres redis integration ok',
      );
    },
    310_000,
  );
});
