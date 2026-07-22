import { spawnSync } from 'node:child_process';

/**
 * Path-B durable-scan suite (real PostgreSQL).
 *
 * Regression guard for the sliding-lookback hole: a candle that stayed
 * unprocessed longer than `LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS` used
 * to fall out of the scan window and was never examined again.
 *
 * The runner needs a DISPOSABLE database: it creates and removes its own
 * fixtures and resets the (rebuildable) 5m reconciliation checkpoint.
 */
const RUN_INTEGRATION =
  process.env.LIMIT_ORDER_CANDLE_CHECKPOINT_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Limit order path-B durable checkpoint integration', () => {
  itIntegration(
    'never loses an unprocessed candle to the lookback window and detects retention gaps',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-candle-checkpoint-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
            LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
            // A deliberately SHORT lookback: the suite proves candles far
            // older than it are still processed.
            LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS: '900000',
            LIMIT_ORDER_CANDLE_RECONCILIATION_WATERMARK_SAFETY_LAG_MS: '300000',
          },
          encoding: 'utf8',
          timeout: 240_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order candle checkpoint integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'bootstrap anchors the watermark before the earliest activated order',
        'a candle older than the lookback window is still processed',
        'a restarted process resumes from the durable checkpoint',
        'a deferred candle does not block later candles',
        'retrying a deferred candle never double fills the order',
        'retention passing the watermark is detected as a gap',
        'a gap fails new quotes/creates closed and stays sticky',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order candle checkpoint integration ok',
      );
    },
    260_000,
  );
});
