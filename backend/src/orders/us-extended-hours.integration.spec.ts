import { spawnSync } from 'node:child_process';

const RUN = process.env.US_EXTENDED_HOURS_DB_INTEGRATION === '1';
const itDbIntegration = RUN ? it : it.skip;

/**
 * PostgreSQL integration for US pre-market/after-hours limit fills
 * (2026-11-10): real matcher and fill transactions — money, reservations,
 * ledger, evidence links, FX preparation, session boundaries, cancel race,
 * lifecycle blocks. Opt-in; runs the real-DB runner in a child process.
 */
describe('US extended-hours limit fills DB integration', () => {
  itDbIntegration(
    'fills pre-market/after-hours limit orders on fresh extended evidence only, with every money invariant',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/us-extended-hours-integration.ts'],
        {
          cwd: process.cwd(),
          env: { ...process.env, US_EXTENDED_HOURS_DB_INTEGRATION: '1' },
          encoding: 'utf8',
          // Up to ~62 s waiting for another suite's USD/KRW row to age out.
          timeout: 240_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'US extended-hours DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      for (const name of [
        'missing fill-time USD/KRW defers the fill with the reservation kept; one bounded preparation per cycle lets it fill',
        'pre-market BUY fills at the extended price with exact money, ledger, evidence and equity snapshot',
        'after-hours SELL of a regular-session order fills and books realized PnL',
        'an order registered inside after-hours fills only on a later tick',
        'pre-submission, stale, regular-source and earlier-window evidence never fills',
        'regular open, overnight and the switch off never accept extended evidence',
        'cancel racing a fill: exactly one wins, reservation and ledger consistent',
        'ended or suspended season and suspended account never fill',
        'repeated cycles never fill an order twice',
      ]) {
        expect(result.stdout.includes(`ok ${name}`)).toBe(true);
      }
      expect(result.stdout.includes('us extended hours integration ok')).toBe(
        true,
      );
    },
    250_000,
  );
});
