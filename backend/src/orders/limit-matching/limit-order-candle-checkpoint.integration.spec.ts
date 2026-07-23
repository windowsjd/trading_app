import { spawnSync } from 'node:child_process';

/**
 * Path-B durable-scan suite (real PostgreSQL).
 *
 * Two regression guards live here.
 *
 * 1. The sliding-lookback hole: a candle that stayed unprocessed longer than
 *    `LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS` used to fall out of the
 *    scan window and was never examined again.
 *
 * 2. The market-order-vs-storage-order hole: the durable position that replaced
 *    the lookback walked the canonical `(openTime, id)` ordering, which is
 *    MARKET time, while rows appear in STORAGE time. A candle written late
 *    arrived behind a position other assets' on-time rows had already pushed
 *    forward, so a scan reading strictly after that position never returned it
 *    again. The sweep now walks `market_candles.ingest_seq`.
 *
 * Plus the two protocols layered on top:
 *
 * 3. WINDOW COMPLETION: ingest_seq orders rows that EXIST; a window whose row
 *    was never written was invisible (feed gap, finalizer failure and genuine
 *    no-trade all looked identical: no row). A per-asset durable cursor now
 *    accounts for every window — canonical row, provider-confirmed no-trade,
 *    or outside-session — records the first unaccountable window as pending,
 *    turns retention passing it into a sticky ASSET-scoped gap, and one
 *    asset's stall never gates another asset.
 *
 * 4. CANDLE REVISION: a correction to an already-processed candle
 *    re-sequences it and is reprocessed additively — newly qualified orders
 *    fill once, executed orders are untouched, and evidence rows are
 *    revision-scoped and immutable.
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
            // The two-phase storage-position guard. The suite ages the stored
            // observation rather than sleeping for it, so this only has to be a
            // real, non-zero bound.
            LIMIT_ORDER_CANDLE_RECONCILIATION_INGEST_SETTLE_GRACE_MS: '5000',
            // Window completion: a generous per-sweep repair budget so the
            // deterministic sync stub is consulted for every asset the suite
            // stalls on purpose, regardless of asset iteration order.
            LIMIT_ORDER_CANDLE_COMPLETION_REPAIR_BUDGET_PER_SWEEP: '50',
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
        'a candle stored after the watermark passed its window is still processed',
        'a candle that only becomes closed later is re-sequenced and swept',
        'an unrelated candle update does not renumber the storage position',
        'the storage position never passes an unsettled observation',
        'retention passing an unscanned matchable candle gaps only that asset',
        'a deferred candle whose row vanished gaps only its own asset',
        'a window with no candle row stalls only its own asset',
        'a provider-confirmed empty window advances the cursor as no-trade',
        'a delayed candle row completes its pending window',
        'an asset retention gap blocks only that asset',
        'a corrected candle is reprocessed as a new revision without double fills',
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
