import { spawnSync } from 'node:child_process';

const RUN_INTEGRATION =
  process.env.LIMIT_ORDER_AUTO_EXECUTION_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Limit order live-trade PostgreSQL + Redis integration', () => {
  itIntegration(
    'persists, recovers, orders, deduplicates, and executes stream events',
    () => {
      const suffix = `${process.pid}-${Date.now()}`;
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-auto-execution-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
            LIMIT_ORDER_EVENT_STREAM_KEY: `limit-order:test:${suffix}`,
            LIMIT_ORDER_EVENT_CONSUMER_GROUP: `limit-order-test-group:${suffix}`,
            LIMIT_ORDER_EVENT_BLOCK_MS: '250',
            LIMIT_ORDER_EVENT_READ_BATCH_SIZE: '20',
            LIMIT_ORDER_CANDIDATE_BATCH_SIZE: '20',
            LIMIT_ORDER_EVENT_MAXLEN: '1000',
            LIMIT_ORDER_PENDING_IDLE_MS: '5000',
            LIMIT_ORDER_RECLAIM_INTERVAL_MS: '1000',
            LIMIT_ORDER_MATCHER_HEARTBEAT_INTERVAL_MS: '500',
            LIMIT_ORDER_MATCHER_HEALTH_MAX_AGE_MS: '3000',
          },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order PostgreSQL + Redis integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'postgres advisory leader and standby takeover',
        'pending event recovery executes once',
        'normal execution and price improvement accounting',
        'price above limit remains submitted',
        'pre-submission receiver timestamp remains submitted',
        'duplicate event never double fills or fills a later order',
        'cancel and execution each win one deterministic ordering',
        'exclusion and execution each win one deterministic ordering',
        'season ending and execution each win one deterministic ordering',
        'publisher Redis outage degrades matcher while cancel remains available',
        'stream retention gap fails closed without a price fallback',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order auto execution postgres redis integration ok',
      );
    },
    190_000,
  );
});
