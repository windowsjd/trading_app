-- Additive only. No existing row is deleted and no applied migration is
-- edited.
--
-- 1. limit_order_deferred_candles.candle_ingest_seq
-- ---------------------------------------------------------------------------
-- The deferred queue tracks candles the path-B sweep could not finish. Candle
-- revision identity is market_candles.ingest_seq (re-assigned by trigger when
-- a correction changes what the window could fill). Without the revision on
-- the queue entry, a PERMANENT entry for revision 1 suppressed revision 2
-- forever: the forward scan skipped the candle because "a deferred row
-- exists", and permanent rows are not retried — a silent, permanent miss on a
-- financial safety net.
--
-- The column is NULLABLE by necessity:
--   * rows enqueued before this column existed cannot have their enqueue-time
--     revision reconstructed (it was never recorded);
--   * rows whose market_candles row retention already removed have no current
--     revision to adopt either — they stay NULL and remain in their existing
--     deferred/permanent state; the retention-gap detector already reports
--     them and only an operator can settle that exposure.
-- NULL is read as "unknown = lowest": any concrete revision replaces it. New
-- writes always carry the revision, so NOT NULL cannot be proven safe for the
-- orphaned backfill rows and is deliberately not applied.
ALTER TABLE "limit_order_deferred_candles" ADD COLUMN     "candle_ingest_seq" BIGINT;

-- Deterministic backfill: adopt the CURRENT revision of every candle that
-- still exists. This is the conservative direction — if the candle was
-- corrected while sitting in the queue, adopting the current revision makes
-- the retry process exactly that revision (the same rows the forward scan
-- would deliver); it can never resurrect an older revision.
UPDATE "limit_order_deferred_candles" d
SET "candle_ingest_seq" = c."ingest_seq"
FROM "market_candles" c
WHERE c."id" = d."market_candle_id"
  AND d."candle_ingest_seq" IS NULL;

-- 2. Window-completion heartbeat, separate from the row-scan heartbeat
-- ---------------------------------------------------------------------------
-- last_run_at / last_successful_run_at describe the ROW SCAN over candle rows
-- that exist. The window-completion supervisor (missing-window accounting)
-- used to hide behind it: its failure was caught, the row scan continued, and
-- markRunSucceeded() stamped the only heartbeat — so a completion pass that
-- failed every run looked healthy. These columns record the completion pass
-- independently; the quote/create health gate checks BOTH heartbeats.
ALTER TABLE "limit_order_reconciliation_checkpoints" ADD COLUMN     "last_window_completion_run_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_window_completion_successful_at" TIMESTAMPTZ(3),
ADD COLUMN     "window_completion_consecutive_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "window_completion_error_code" TEXT,
ADD COLUMN     "window_completion_error_message" TEXT;

-- 3. Indexes
-- ---------------------------------------------------------------------------
-- Index-only probe for the revision-aware forward-scan exclusion
-- (d.market_candle_id = c.id AND d.candle_ingest_seq >= c.ingest_seq).
CREATE INDEX "limit_order_deferred_candles_market_candle_id_candle_ingest_idx" ON "limit_order_deferred_candles"("market_candle_id", "candle_ingest_seq");

-- Asset-scoped backlog gate: per-asset deferred/permanent counts and oldest
-- ages are read on every limit quote/create for that asset.
CREATE INDEX "limit_order_deferred_candles_asset_id_status_first_deferred_idx" ON "limit_order_deferred_candles"("asset_id", "status", "first_deferred_at");
