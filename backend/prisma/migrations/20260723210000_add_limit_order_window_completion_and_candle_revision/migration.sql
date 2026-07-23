-- Path-B window completion protocol + candle revision awareness.
--
-- Strictly additive: one new table, new columns on two existing tables (with
-- deterministic backfill), one unique index replaced by a wider one on the
-- SAME leading column. No column is dropped or retyped, no existing migration
-- is edited, no row is deleted, no historical value is changed.
--
-- WHY
-- ---
-- 1. `market_candles.ingest_seq` orders rows that EXIST. A window whose row
--    was never written is invisible to it: a finalizer that skipped the
--    window, a feed gap, a failed DB write, and a genuine no-trade window all
--    look identical — no row. `market_candle_finalization_checkpoints` is the
--    durable per-asset cursor that tells them apart: it advances over a
--    window only when the window is ACCOUNTED FOR (canonical row, explicit
--    provider-confirmed no-trade, outside market session, or predating the
--    asset's earliest activated order), records the first unaccountable
--    window as pending, and turns retention passing an unresolved window into
--    a sticky per-asset gap.
--
-- 2. The ingest-seq trigger re-sequences a candle whose correction changes
--    what the window could fill (low/window/closed state). But a processed
--    row keyed on the candle id alone blocked re-examination FOREVER, so a
--    corrected candle was re-sequenced and then ignored. Processed rows now
--    record WHICH revision (`candle_ingest_seq`) they cover, and evidence
--    rows become revision-scoped and immutable: a correction produces a NEW
--    evidence row; fills recorded under the previous revision keep pointing
--    at the previous row verbatim.

-- ---------------------------------------------------------------------------
-- Per-asset window completion cursor
-- ---------------------------------------------------------------------------
CREATE TABLE "market_candle_finalization_checkpoints" (
  "asset_id" TEXT NOT NULL,
  "interval" TEXT NOT NULL,
  "finalized_through_open_time" TIMESTAMPTZ(3),
  "finalized_through_close_time" TIMESTAMPTZ(3) NOT NULL,
  "last_advanced_at" TIMESTAMPTZ(3),
  "last_evaluated_at" TIMESTAMPTZ(3),
  "pending_window_open_time" TIMESTAMPTZ(3),
  "pending_since" TIMESTAMPTZ(3),
  "pending_attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" TEXT,
  "degraded_reason" TEXT,
  "gap_detected_at" TIMESTAMPTZ(3),
  "gap_from_open_time" TIMESTAMPTZ(3),
  "gap_to_open_time" TIMESTAMPTZ(3),
  "no_trade_window_count" INTEGER NOT NULL DEFAULT 0,
  "outside_session_window_count" INTEGER NOT NULL DEFAULT 0,
  "repaired_window_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "market_candle_finalization_checkpoints_pkey" PRIMARY KEY ("asset_id", "interval"),
  CONSTRAINT "market_candle_finalization_checkpoints_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "market_candle_finalization_checkpoints_pending_since_idx"
  ON "market_candle_finalization_checkpoints" ("pending_since");
CREATE INDEX "market_candle_finalization_checkpoints_gap_detected_at_idx"
  ON "market_candle_finalization_checkpoints" ("gap_detected_at");

-- ---------------------------------------------------------------------------
-- Processed candles: which revision was processed
-- ---------------------------------------------------------------------------
ALTER TABLE "limit_order_processed_candles"
  ADD COLUMN IF NOT EXISTS "candle_ingest_seq" BIGINT,
  ADD COLUMN IF NOT EXISTS "revision_count" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "first_processed_at" TIMESTAMPTZ(3);

-- Existing processed rows cover the candle's revision AS OF this migration:
-- any correction before now was invisible to the old code (that is the defect
-- being fixed), and treating history as "processed at the current revision"
-- is the only reading that does not retroactively re-fill old candles the
-- moment this deploys. The FK guarantees the candle row still exists.
UPDATE "limit_order_processed_candles" p
SET
  "candle_ingest_seq" = COALESCE(c."ingest_seq", 1),
  "first_processed_at" = p."processed_at"
FROM "market_candles" c
WHERE c."id" = p."market_candle_id"
  AND p."candle_ingest_seq" IS NULL;

ALTER TABLE "limit_order_processed_candles"
  ALTER COLUMN "candle_ingest_seq" SET NOT NULL;
ALTER TABLE "limit_order_processed_candles"
  ALTER COLUMN "first_processed_at" SET NOT NULL,
  ALTER COLUMN "first_processed_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- Evidence: revision-scoped, immutable per revision
-- ---------------------------------------------------------------------------
ALTER TABLE "limit_order_candle_evidences"
  ADD COLUMN IF NOT EXISTS "candle_ingest_seq" BIGINT;

UPDATE "limit_order_candle_evidences" e
SET "candle_ingest_seq" = COALESCE(c."ingest_seq", 1)
FROM "market_candles" c
WHERE c."id" = e."market_candle_id"
  AND e."candle_ingest_seq" IS NULL;

ALTER TABLE "limit_order_candle_evidences"
  ALTER COLUMN "candle_ingest_seq" SET NOT NULL;

-- The wider unique key REPLACES the single-column one so a corrected candle
-- can carry one evidence row PER revision. Created before the old index is
-- dropped, so there is no window with no uniqueness at all.
CREATE UNIQUE INDEX "limit_order_candle_evidences_market_candle_id_candle_inges_key"
  ON "limit_order_candle_evidences" ("market_candle_id", "candle_ingest_seq");
DROP INDEX IF EXISTS "limit_order_candle_evidences_market_candle_id_key";
