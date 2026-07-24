import { spawnSync } from 'node:child_process';

const RUN = process.env.LIMIT_ORDER_MATCHING_DB_INTEGRATION === '1';
const itDbIntegration = RUN ? it : it.skip;

/**
 * PostgreSQL integration for the scheduler-based limit-order matcher (paths
 * A/B): fill at the snapshot price / at the limit price off a candle touch,
 * pinned fee rate, partial-candle exclusion, cancel-vs-fill, ended season, and
 * evidence isolation. Opt-in; runs the real-DB runner in a child process.
 */
describe('Limit order scheduler matching DB integration', () => {
  itDbIntegration(
    'fills path A/B correctly and defends the reservation, cancel, season, and evidence invariants',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-matching-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, LIMIT_ORDER_MATCHING_DB_INTEGRATION: '1' },
          encoding: 'utf8',
          timeout: 180_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order matching DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      for (const name of [
        'path A fills at the snapshot price with improvement',
        'path A does not fill above the limit',
        'path B fills at the limit price off a candle touch',
        'path B never uses the partial submit candle',
        'fill uses the pinned reservation fee rate, not the season rate',
        'a canceled order is skipped by the matcher',
        'an ended season is not filled',
        'candle evidence never becomes a price snapshot',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain('limit order matching integration ok');
    },
    190_000,
  );
});
