import { spawnSync } from 'node:child_process';

/**
 * EXISTING-DATABASE UPGRADE suite (real PostgreSQL).
 *
 * Every other path-B suite runs against a database with all migrations already
 * applied. The defect this covers only exists in the ORDER the migrations were
 * applied in: a queue entry parked as PERMANENT before
 * `limit_order_deferred_candles.candle_ingest_seq` existed, whose candle was
 * then CORRECTED, and which the column's backfill stamped with that corrected
 * revision — making the correction unreachable by the forward scan (tracked >=
 * current) AND by the retry loop (permanent).
 *
 * Reproducing that requires actually upgrading a database through the
 * intermediate schema, so the runner creates its own scratch database and
 * deploys migrations in three stages. It never touches the database the rest
 * of the suite uses; it only needs the same SERVER.
 */
const RUN_INTEGRATION =
  process.env.LIMIT_ORDER_LEGACY_DEFERRED_MIGRATION_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Limit order legacy deferred migration upgrade integration', () => {
  itIntegration(
    'reopens a legacy permanent entry so a pre-migration correction is still filled',
    () => {
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-legacy-deferred-migration-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
            LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
          },
          encoding: 'utf8',
          timeout: 300_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order legacy deferred migration integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        // The defects themselves, asserted BEFORE each fix is deployed: if
        // these ever stop holding, the fixes protect against nothing.
        'the pre-fix backfill stamps a permanent entry with the CORRECTED revision',
        'the created_at boundary reopens past-clock rows but MISSES future-clock rows',
        'an unverified current row neither suppresses the scan nor passes health',
        'the provenance migration reopens the legacy permanent entry for re-verification',
        'a legacy entry whose candle is gone stays parked as an orphan',
        'a future-created_at legacy entry is reopened despite the clock skew',
        'a future-created_at legacy entry without a candle becomes an orphan',
        'an unverified revision-aware entry is conservatively re-verified',
        'invalid current rows are conservatively reclassified',
        'a legacy orphan keeps forensic evidence but loses unearned verification',
        'a runtime-verified entry is untouched by the re-verification migration',
        'the provenance CHECK rejects invalid rows and accepts valid ones',
        're-running the provenance migrations changes nothing',
        'the reopened entry lets the sweep process the corrected revision',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      expect(result.stdout).toContain(
        'limit order legacy deferred migration integration ok',
      );
    },
    320_000,
  );
});
